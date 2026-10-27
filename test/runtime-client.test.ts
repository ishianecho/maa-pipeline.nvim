import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = process.cwd();

async function loadRuntimeClient(t: any) {
  const output = path.join(root, "server", "dist", "runtime-client.test.mjs");
  t.after(async () => rm(output, { force: true }));
  await esbuild.build({
    entryPoints: [
      {
        in: path.join(root, "server", "client.ts"),
        out: "runtime-client.test",
      },
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    mainFields: ["module", "main"],
    external: [],
    banner: {
      js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const maa = new Proxy({}, {
  get(_, prop) { return globalThis.maa?.[prop]; },
  set(_, prop, value) { globalThis.maa[prop] = value; return true; },
  has(_, prop) { return prop in (globalThis.maa || {}); },
});
`,
    },
  });
  return (await import(pathToFileURL(output).href)).RuntimeClient;
}

function testProject() {
  return {
    root: "/maa/project",
    config: {
      controller: "controller",
      resource: "resource",
      playcover: { address: "127.0.0.1:1" },
    },
    bundle: {
      content: {
        object: {
          agent: [{ child_exec: "agent" }],
          controller: [
            {
              name: "controller",
              type: "PlayCover",
              playcover: { address: "127.0.0.1:1" },
            },
          ],
          resource: [{ name: "resource", path: ["."] }],
        },
      },
    },
  };
}

function testProjectAt(root: string) {
  const project = testProject() as { root: string };
  project.root = root;
  return project;
}

test("does not retry setup after an external agent fails", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const calls = [];
  const client = new RuntimeClient({
    sendNotification: (_method: string, params: any) => logs.push(params),
  } as any);
  (client as any).request = async (method, ..._args) => {
    calls.push(method);
    if (method === "setupInstance") return { error: "maa.debug.init-resource-failed" };
    return undefined;
  };
  client.failedAgents.add("agent");

  const setup = await client.setup(testProject());

  assert.equal(setup.handle, undefined);
  assert.deepEqual(calls, ["fetchConstants", "setupInstance"]);
  assert.ok(logs.some((log) => log.level === "error" && log.message.includes("agent")));
  assert.equal(client.failedAgents.size, 0);
});

test("logs failed external agents and reports them stopped to the runtime", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const requests = [];
  const client = new RuntimeClient(
    {
      sendNotification: (_method: string, params: any) => logs.push(params),
    } as any,
    { daemon: false },
  );
  (client as any).rpc = { sendRequest: async (...args) => requests.push(args) };
  client.agentOptions.set(process.execPath, false);

  await client.startAgent(process.execPath, ["-e", ""]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(
    logs.some((log) => log.level === "error" && /failed: exited with code 0/.test(log.message)),
  );
  assert.equal(requests.at(-1)?.[1], "agentStopped");
});

test("allows daemon agent launchers to exit without treating them as failures", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const requests = [];
  const client = new RuntimeClient(
    {
      sendNotification: (_method: string, params: any) => logs.push(params),
    } as any,
    { daemon: true },
  );
  (client as any).rpc = { sendRequest: async (...args) => requests.push(args) };
  client.agentOptions.set(process.execPath, true);

  await client.startAgent(process.execPath, ["-e", ""]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(
    logs.some((log) => log.level === "info" && log.message.includes("daemon agent launcher")),
  );
  assert.equal(client.failedAgents.size, 0);
  assert.equal(requests.length, 0);
});

test("reuses a daemon instance while the controller type is unchanged", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const calls = [];
  const client = new RuntimeClient({ sendNotification: () => {} } as any, { daemon: true });
  (client as any).request = async (method, ...args) => {
    calls.push(method);
    if (method === "setupInstance") return { handle: "handle" };
    return undefined;
  };

  const first = await client.setup(testProject());
  const second = await client.setup(testProject());

  assert.equal(first.handle, "handle");
  assert.equal(second.handle, "handle");
  assert.deepEqual(calls, ["fetchConstants", "setupInstance"]);
});

test("feeds trace notifications to the collector and emits trace snapshots", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const notifications = [];
  const client = new RuntimeClient({
    sendNotification: (method: string, params: any) => notifications.push({ method, params }),
  } as any);

  (client as any).trace.ingest("inst", {
    msg: "PipelineNode.Starting",
    task_id: 1,
    node_id: 3,
    name: "NodeA",
  });
  const handled = (client as any).trace.ingest("inst", {
    msg: "PipelineNode.Succeeded",
    task_id: 1,
    node_id: 3,
    name: "NodeA",
  });

  assert.equal(handled, true);
  const traces = notifications.filter((item) => item.method === "maa-pipeline/trace");
  assert.ok(traces.length >= 1);
  assert.equal(traces.at(-1).params.entries[0].name, "NodeA");
  assert.equal(traces.at(-1).params.entries[0].status, "succeeded");
});

test("resolves the framework from a node_modules dependency", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const root = await mkdtemp(path.join(tmpdir(), "maa-resolve-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, "node_modules", "@maaxyz", "maa-node");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@maaxyz/maa-node", version: "5.14.0" }),
  );

  const client = new RuntimeClient({ sendNotification: () => {} } as any);
  const local = await (client as any).resolveProjectModule(root);

  assert.deepEqual(local, {
    module: path.join(root, "node_modules"),
    binding: null,
    version: "5.14.0",
  });
});

test("finds a MaaNode.node deployment anywhere in the project and reads its version", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const root = await mkdtemp(path.join(tmpdir(), "maa-resolve-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const deploy = path.join(root, "custom", "nested", "maafw");
  await mkdir(deploy, { recursive: true });
  await writeFile(path.join(deploy, "MaaNode.node"), "");
  await writeFile(
    path.join(deploy, "version.json"),
    JSON.stringify({ versions: { maafw: "v5.15.0-beta.1" } }),
  );

  const client = new RuntimeClient({ sendNotification: () => {} } as any);
  const local = await (client as any).resolveProjectModule(root);

  assert.deepEqual(local, { module: null, binding: deploy, version: "5.15.0-beta.1" });
});

test("reads the version marker placed next to the deployment directory", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const root = await mkdtemp(path.join(tmpdir(), "maa-resolve-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const deploy = path.join(root, "install", "maafw");
  await mkdir(deploy, { recursive: true });
  await writeFile(path.join(deploy, "MaaNode.node"), "");
  await writeFile(
    path.join(root, "install", "version.json"),
    JSON.stringify({ versions: { maafw: "v5.15.0" } }),
  );

  const client = new RuntimeClient({ sendNotification: () => {} } as any);
  const local = await (client as any).resolveProjectModule(root);

  assert.deepEqual(local, { module: null, binding: deploy, version: "5.15.0" });
});

test("anchors the search at the git repository root above the project root", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const repo = await mkdtemp(path.join(tmpdir(), "maa-resolve-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  const deploy = path.join(repo, "install", "maafw");
  await mkdir(deploy, { recursive: true });
  await writeFile(path.join(deploy, "MaaNode.node"), "");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const projectRoot = path.join(repo, "install");
  await mkdir(path.join(projectRoot, "assets"), { recursive: true });

  const client = new RuntimeClient({ sendNotification: () => {} } as any);
  const local = await (client as any).resolveProjectModule(
    await (client as any).frameworkRoot(projectRoot),
  );

  assert.deepEqual(local, { module: null, binding: deploy, version: null });
});

test("prepare throws when the project ships no MaaFramework", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const root = await mkdtemp(path.join(tmpdir(), "maa-resolve-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"), { recursive: true });

  const client = new RuntimeClient({ sendNotification: () => {} } as any, {
    data_dir: path.join(root, "data"),
  });

  await assert.rejects(client.prepare(testProjectAt(root)), /No MaaFramework found in/);
});

test("requests recognition details against the traced instance", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const requests = [];
  const client = new RuntimeClient({ sendNotification: () => {} } as any);
  (client as any).rpc = {
    sendRequest: async (...args) => {
      requests.push(args);
      return {
        info: { name: "NodeA", algorithm: "OCR", hit: true, box: null, detail: null },
        raw: "",
        draws: [],
      };
    },
  };

  (client as any).trace.ingest("inst", { msg: "Task.Starting", task_id: 1, entry: "Entry" });
  await new Promise((resolve) => setImmediate(resolve));
  const detail = await (client as any).recoDetail(7);

  assert.equal(detail.info.name, "NodeA");
  assert.deepEqual(requests.at(-1).slice(1), ["getRecoDetail", ["inst", "7"]]);
});
