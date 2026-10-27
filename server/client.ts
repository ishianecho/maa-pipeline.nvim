import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";

import { buildControllerRuntime, buildResourceRuntime } from "@nekosu/maa-pipeline-manager";
import {
  hostToSubReq,
  initNoti,
  logNoti,
  shutdownNoti,
  subToHostReq,
} from "@nekosu/maa-server-proto";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc";

import { resolveAgent, runtimeAgents } from "./agent.ts";
import { encodeBase64Json, jpegDimensions, pngDimensions } from "./utils.ts";
import { formatRuntimeLogLine, parseLogLine } from "./log.ts";
import { TraceCollector, type RecoDetailInfo, type RecoDetailResult } from "./trace.ts";
import type {
  ActiveTask,
  AgentProcess,
  RuntimeConnection,
  RuntimeOptions,
  RuntimeProject,
  RuntimeSetupResult,
  RuntimeLogPayload,
} from "./types.ts";

const runtimeScript = path.join(__dirname, "maa-runtime.mjs");

export class RuntimeSetupError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RuntimeSetupError";
  }
}

function runtimeConfig(project: RuntimeProject, constants: any) {
  const data = project.bundle.content.object;
  const controller = buildControllerRuntime(data, project.config, constants);
  if (typeof controller === "string") throw new Error(controller);
  const resource = buildResourceRuntime(data, project.config);
  if (typeof resource === "string") throw new Error(resource);
  return {
    root: project.root,
    controller,
    resource,
    task: { tasks: [] },
    agent: runtimeAgents(project),
  };
}

export class RuntimeClient {
  connection: RuntimeConnection;
  options: {
    dataDir?: string;
    maaVersion: string | null;
    timeout: number;
    debugMode: boolean;
    saveDraw: boolean;
    saveOnError: boolean;
    recoImageCacheLimit: number;
    locale: string;
    daemon: boolean;
  };
  modulePath: string | null = null;
  bindingPath: string | null = null;
  rpc: MessageConnection | null = null;
  server: net.Server | null = null;
  process: ChildProcess | null = null;
  active: ActiveTask | null = null;
  running: string | null = null;
  agents = new Map<string, AgentProcess>();
  failedAgents = new Set<string>();
  agentOptions = new Map<string, boolean>();
  controllerType: string | null = null;
  daemonHandle: string | null = null;
  readonly trace = new TraceCollector({
    onChange: (snapshot) => {
      this.connection.sendNotification("maa-pipeline/trace", snapshot);
    },
  });

  constructor(connection: RuntimeConnection, options: RuntimeOptions = {}) {
    this.connection = connection;
    this.options = {
      dataDir: options.data_dir,
      maaVersion: null,
      timeout: options.timeout ?? 60_000,
      debugMode: options.debug_mode ?? true,
      saveDraw: options.save_draw ?? false,
      saveOnError: options.save_on_error ?? true,
      recoImageCacheLimit: options.reco_image_cache_limit ?? 64,
      locale: options.locale === "zh" ? "zh" : "en",
      daemon: options.daemon ?? true,
    };
  }

  log(payload: RuntimeLogPayload) {
    const source = payload.source ?? "maa-runtime";
    try {
      const entry = parseLogLine(formatRuntimeLogLine({ ...payload, source }));
      if (!entry) return;
      this.connection.sendNotification("maa-pipeline/runtimeLog", {
        level: payload.level,
        message: payload.message,
        source,
        entry,
      });
    } catch {
      this.connection.sendNotification("maa-pipeline/runtimeLog", {
        level: payload.level,
        message: payload.message,
        source,
      });
    }
  }

  private async findBinding(root: string): Promise<string | null> {
    let queue: string[] = [root];
    for (let depth = 0; depth < 6 && queue.length > 0; depth += 1) {
      const next: string[] = [];
      for (const dir of queue) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isFile() && entry.name === "MaaNode.node") return dir;
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            next.push(path.join(dir, entry.name));
          }
        }
      }
      queue = next;
    }
    return null;
  }

  private async frameworkRoot(root: string): Promise<string> {
    let current = path.resolve(root);
    for (let depth = 0; depth < 16; depth += 1) {
      try {
        await access(path.join(current, ".git"));
        return current;
      } catch {
        // keep walking up to the repository root
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return path.resolve(root);
  }

  private async resolveProjectModule(root: string) {
    const moduleFolder = path.join(root, "node_modules");
    try {
      const pkg = JSON.parse(
        await readFile(path.join(moduleFolder, "@maaxyz", "maa-node", "package.json"), "utf8"),
      );
      if (typeof pkg.version === "string") {
        return { module: moduleFolder, binding: null as string | null, version: pkg.version };
      }
    } catch {
      // project does not declare @maaxyz/maa-node
    }
    const binding = await this.findBinding(root);
    if (!binding) return null;
    let version: string | null = null;
    for (const marker of [
      path.join(binding, "version.json"),
      path.join(path.dirname(binding), "version.json"),
    ]) {
      try {
        const versionJson = JSON.parse(await readFile(marker, "utf8"));
        const raw = versionJson?.versions?.maafw;
        if (typeof raw === "string") {
          version = raw.replace(/^v/, "");
          break;
        }
      } catch {
        // version marker is optional
      }
    }
    return { module: null as string | null, binding, version };
  }

  async prepare(project: RuntimeProject) {
    if (!this.options.dataDir) throw new Error("init_options.runtime.data_dir is required");
    const root = await this.frameworkRoot(project.root);
    const local = await this.resolveProjectModule(root);
    if (!local) {
      throw new Error(
        `No MaaFramework found in ${root}; expected node_modules/@maaxyz/maa-node or a MaaNode.node deployment`,
      );
    }
    this.modulePath = local.module;
    this.bindingPath = local.binding;
    this.options.maaVersion = local.version;
    this.log({
      level: "info",
      message: local.binding
        ? `Using MaaFramework ${local.version ?? "unknown"} from ${local.binding}`
        : `Using @maaxyz/maa-node ${local.version} from ${root}`,
      source: "maa-runtime",
    });
  }

  private async isAdmin() {
    if (process.platform !== "win32") return false;
    return await new Promise<boolean>((resolve) => {
      execFile("net.exe", ["session"], (error) => resolve(!error));
    });
  }

  async ensure(project: RuntimeProject) {
    if (this.rpc) return this.rpc;
    await this.prepare(project);
    await mkdir(path.join(this.options.dataDir!, "logs"), { recursive: true });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
      server.once("listening", () => resolve());
    });
    this.server = server;
    const id = randomUUID();
    const address = server.address() as net.AddressInfo;
    let rejectConnection: (error: unknown) => void;
    let connectionTimer: NodeJS.Timeout;
    const connected = new Promise((resolve, reject) => {
      rejectConnection = reject;
      connectionTimer = setTimeout(
        () => reject(new Error("Maa server connection timed out")),
        60_000,
      );
      server.once("connection", (socket) => {
        const rpc = createMessageConnection(socket as any, socket as any);
        rpc.onNotification(initNoti, (clientId) => {
          if (clientId !== id) return;
          clearTimeout(connectionTimer);
          this.rpc = rpc;
          this.bind(rpc);
          resolve(rpc);
        });
        rpc.listen();
      });
    });

    const runtimeArgs = [
      runtimeScript,
      encodeBase64Json({
        id,
        port: address.port,
        ...(this.bindingPath ? { binding: this.bindingPath } : { module: this.modulePath! }),
        maaLog: path.join(this.options.dataDir!, "logs"),
        debugMode: this.options.debugMode,
        saveDraw: this.options.saveDraw,
        saveOnError: this.options.saveOnError,
        recoImageCacheLimit: this.options.recoImageCacheLimit,
      }),
    ];
    const elevated = process.platform === "win32" && !(await this.isAdmin());
    const child = elevated
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList @('${runtimeArgs[0].replaceAll("'", "''")}', '${runtimeArgs[1].replaceAll("'", "''")}') -Verb RunAs -WindowStyle Hidden`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        )
      : spawn(process.execPath, runtimeArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = elevated ? null : child;
    child.stdout?.on("data", (data) =>
      this.log({ level: "info", message: data.toString().trim(), source: "maa-runtime" }),
    );
    child.stderr?.on("data", (data) =>
      this.log({ level: "error", message: data.toString().trim(), source: "maa-runtime" }),
    );
    if (elevated) {
      child.once("exit", (code) => {
        if (code === 0) return;
        clearTimeout(connectionTimer);
        rejectConnection(
          new Error(
            "Failed to start MaaServer with administrator permissions; UAC request was denied",
          ),
        );
      });
    }
    child.once("error", (error) => {
      clearTimeout(connectionTimer);
      rejectConnection(error);
    });
    child.once("exit", (code) => {
      if (this.process !== child) return;
      this.log({
        level: code === 0 ? "info" : "error",
        message: `Maa server exited with code ${code}`,
        source: "maa-runtime",
      });
      if (!this.rpc) {
        clearTimeout(connectionTimer);
        rejectConnection(new Error(`Maa server exited with code ${code}`));
      }
      this.process = null;
      this.rpc = null;
      this.active = null;
    });
    try {
      return await connected;
    } catch (error) {
      if (this.process === child) {
        child.kill();
        this.process = null;
      }
      if (this.server === server) {
        server.close();
        this.server = null;
      }
      throw error;
    }
  }

  bind(rpc: MessageConnection) {
    rpc.onNotification(logNoti, (level, message) => {
      const source = "maa-runtime";
      let entry: unknown = null;
      try {
        entry = parseLogLine(`[${level}] ${message}`, source) ?? null;
      } catch {
        // entry stays null
      }
      this.connection.sendNotification("maa-pipeline/runtimeLog", {
        level,
        message,
        source,
        entry,
      });
    });
    rpc.onRequest(subToHostReq, async (method, args) => {
      if (method === "pushNotify") {
        try {
          this.trace.ingest(String(args[0]), args[1]);
        } catch {
          this.log({
            level: "warn",
            message: "Failed to process a Maa trace notification",
            source: "maa-runtime",
          });
        }
        const source = "maa-runtime";
        let body: string;
        try {
          body = JSON.stringify(args[1]);
        } catch {
          body = String(args[1]);
        }
        let entry: unknown = null;
        try {
          entry = parseLogLine(`[info] ${body}`, source) ?? null;
        } catch {
          // entry stays null
        }
        this.connection.sendNotification("maa-pipeline/runtimeLog", {
          level: "info",
          message: body,
          source,
          entry,
        });
        return null;
      }
      if (method === "startTask")
        return this.startAgent(...(args as [string, string[], string, Record<string, string>]));
      if (method === "stopAgent") return this.stopAgent(args[0]);
      if (method === "startDebugSession") {
        this.log({
          level: "error",
          message: "Debug-session agents require VS Code and are not supported",
          source: "maa-runtime",
        });
        return null;
      }
      if (method === "quickPick") {
        const actions = (args[0] as string[]).map((title) => ({ title }));
        const selected = await this.connection.window.showInformationMessage(
          "Select a Maa item",
          ...actions,
        );
        return selected?.title ?? null;
      }
      return null;
    });
  }

  request<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.rpc) throw new Error("Maa server is not connected");
    return this.rpc.sendRequest(hostToSubReq, method, args) as Promise<T>;
  }

  controllerReady(project: RuntimeProject) {
    if (project.config.controller === "$fixed") return !!project.config.vscFixed?.image;
    const controller = project.bundle.content.object.controller?.find(
      (item: any) => item.name === project.config.controller,
    );
    if (!controller) return false;
    if (controller.type === "Adb") {
      const value = project.config.adb;
      return (
        !!value?.adb_path &&
        !!value?.address &&
        value.screencap !== undefined &&
        value.input !== undefined &&
        value.config !== undefined
      );
    }
    if (controller.type === "Win32") return !!project.config.win32?.hwnd;
    if (controller.type === "Gamepad") return !!project.config.gamepad?.hwnd;
    if (controller.type === "PlayCover") return !!project.config.playcover?.address;
    if (controller.type === "Linux") return !!project.config.linux;
    return false;
  }

  async discoverController(project: RuntimeProject, name: string) {
    if (name === "$fixed") {
      return {
        config_key: "vscFixed",
        fields: [{ key: "image", label: "Absolute image path", required: true }],
      };
    }
    const controller = project.bundle.content.object.controller?.find(
      (item: any) => item.name === name,
    );
    if (!controller) throw new Error(`Unknown controller ${name}`);
    if (controller.type === "Adb") {
      await this.ensure(project);
      const devices = await this.request<any[]>("refreshAdb", project.config.adb?.adb_path);
      return {
        items: devices.map((device) => ({
          label: `${device[0]} — ${device[2]}`,
          config: {
            adb: {
              adb_path: device[1],
              address: device[2],
              screencap: device[3],
              input: device[4],
              config: JSON.parse(device[5]),
            },
          },
        })),
      };
    }
    if (controller.type === "Win32" || controller.type === "Gamepad") {
      await this.ensure(project);
      const desktop = controller.type === "Win32" ? controller.win32 : controller.gamepad;
      const classRegex = desktop?.class_regex ? new RegExp(desktop.class_regex) : null;
      const windowRegex = desktop?.window_regex ? new RegExp(desktop.window_regex) : null;
      const devices = (await this.request<any[]>("refreshDesktop")).filter(
        (device) =>
          (!classRegex || classRegex.test(device[1])) &&
          (!windowRegex || windowRegex.test(device[2])),
      );
      const key = controller.type === "Win32" ? "win32" : "gamepad";
      return {
        items: devices.map((device) => ({
          label: `${device[2]} — ${device[1]}`,
          config: { [key]: { hwnd: device[0] } },
        })),
      };
    }
    if (controller.type === "PlayCover") {
      return {
        config_key: "playcover",
        fields: [
          {
            key: "address",
            label: "PlayCover address (host:port)",
            required: true,
          },
        ],
      };
    }
    if (controller.type === "Linux") {
      await this.ensure(project);
      const meta = controller.linux ?? {};
      const screencap = meta.screencap ?? "Wlr";
      const input = meta.input ?? "Wlr";
      if (screencap === "PipeWire" && meta.pipewire_source === "Portal") {
        throw new Error(
          "Linux PipeWire Portal controllers are not supported by the upstream Maa server",
        );
      }
      const fields: any[] = [];
      if ((screencap === "PipeWire" && meta.pipewire_source !== "Portal") || input === "Libei") {
        const instances = await this.request<any[]>("refreshGamescope");
        fields.push({
          key: "display_no",
          label: "Gamescope display",
          items: instances.map((item) => ({
            label: `Display ${item[0]} — ${item[2]}`,
            value: item[0],
          })),
        });
      }
      if (screencap === "Wlr" || input === "Wlr") {
        const compositors = await this.request<any[]>("refreshWlrCompositor");
        fields.push({
          key: "wlr_socket_path",
          label: "Wayland compositor",
          items: compositors.map((item) => ({
            label: `${item[2]} — ${item[1]}`,
            value: item[1],
          })),
        });
      }
      if (input === "UInput") {
        fields.push(
          { key: "uinput_screen_width", label: "UInput screen width", number: true },
          { key: "uinput_screen_height", label: "UInput screen height", number: true },
        );
      }
      return { config_key: "linux", fields };
    }
    throw new Error(`Unsupported controller type ${controller.type}`);
  }

  async startAgent(exec: string, args: string[], cwd?: string, env: Record<string, string> = {}) {
    const id = randomUUID();
    const name = path.basename(exec, path.extname(exec));
    const daemon = this.options.daemon || this.agentOptions.get(exec) === true;
    this.log({
      level: "info",
      message: `Starting external ${daemon ? "daemon " : ""}agent ${name}`,
      source: name,
    });
    this.failedAgents.delete(name);

    const agent = await resolveAgent(exec, cwd);

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...env,
      PI_INTERFACE_VERSION: "v2.5.0",
      PI_CLIENT_NAME: "Neovim",
      PI_CLIENT_VERSION: "0.1.0",
      PI_CLIENT_LANGUAGE: this.options.locale,
      PI_CLIENT_MAAFW_VERSION: this.options.maaVersion ?? "",
      PI_VERSION: "",
    };

    if (process.platform === "win32" && this.controllerType === "Win32") {
      const pluginRuntimeDirectory = this.bindingPath
        ? this.bindingPath
        : this.modulePath
          ? path.join(this.modulePath, "@maaxyz", `maa-node-${process.platform}-${process.arch}`)
          : undefined;
      const existingKey = Object.keys(childEnv).find((k) => k.toLowerCase() === "path");
      const inheritedPath = existingKey ? childEnv[existingKey] : undefined;
      if (existingKey && existingKey !== "Path") {
        delete childEnv[existingKey];
      }
      childEnv.Path = [pluginRuntimeDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
    }

    const child = spawn(agent.executable, args, {
      cwd: agent.cwd,
      env: childEnv as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.agents.set(id, { name, child, daemon });
    child.once("spawn", () => {
      this.log({
        level: "info",
        message: `External agent ${name} started (${agent.executable})`,
        source: name,
      });
    });
    child.stdout?.on("data", (data) =>
      this.log({ level: "info", message: data.toString().trim(), source: name }),
    );
    child.stderr?.on("data", (data) =>
      this.log({ level: "error", message: data.toString().trim(), source: name }),
    );
    const stopUpstream = () => {
      if (!this.rpc) return;
      void this.request("agentStopped", id).catch(() => {});
    };
    const stopped = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.agents.delete(id)) return;
      if (daemon) {
        if (code === 0) {
          this.log({
            level: "info",
            message: `External daemon agent launcher ${name} exited; waiting for its service`,
            source: name,
          });
          return;
        }
        this.failedAgents.add(name);
      }
      this.failedAgents.add(name);
      const reason =
        code !== null
          ? `with code ${code}`
          : signal
            ? `with signal ${signal}`
            : "without an exit status";
      this.log({
        level: "error",
        message: `External agent ${name} failed: exited ${reason}`,
        source: name,
      });
      stopUpstream();
    };
    child.once("error", (error) => {
      if (!this.agents.delete(id)) return;
      this.failedAgents.add(name);
      this.log({
        level: "error",
        message: `External agent ${name} failed to start: ${error.message}`,
        source: name,
      });
      stopUpstream();
    });
    child.once("exit", stopped);
    return id;
  }

  stopAgent(id: string) {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.agents.delete(id);
    this.log({
      level: "info",
      message: `Stopping external agent ${agent.name}`,
      source: agent.name,
    });
    agent.child.kill();
  }

  async setup(project: RuntimeProject) {
    const controllerName =
      typeof project.config.controller === "string"
        ? project.config.controller
        : (project.config.controller?.name ?? "");
    const controllerDecl = project.bundle.content.object.controller?.find(
      (c: any) => c.name === controllerName,
    );
    const controllerType = controllerDecl?.type ?? "";

    if (this.options.daemon && this.daemonHandle && this.controllerType === controllerType) {
      return { handle: this.daemonHandle };
    }
    if (this.daemonHandle) await this.destroyDaemon();

    const constants = await this.request("fetchConstants");
    const config = runtimeConfig(project, constants);
    this.controllerType = controllerType;
    this.agentOptions = new Map(config.agent.map((agent) => [agent.child_exec, false]));
    const setup = await this.request<RuntimeSetupResult>(
      "setupInstance",
      config,
      this.options.timeout,
    );
    if (this.options.daemon && setup.handle) this.daemonHandle = setup.handle;

    if (!setup.handle && setup.error === "maa.debug.init-resource-failed") {
      const failedAgents = [...this.failedAgents];
      if (failedAgents.length) {
        this.failedAgents.clear();
        this.log({
          level: "error",
          message: `External agents failed to start; the task will not run: ${failedAgents.join(", ")}`,
          source: "maa-runtime",
        });
      }
    }

    return setup;
  }

  async run(project: RuntimeProject, task: string) {
    if (this.running) throw new Error(`Task ${this.running} is already running`);
    this.running = task;
    this.log({ level: "info", message: `Starting task ${task}`, source: "maa-runtime" });
    try {
      await this.ensure(project);
      const setup = await this.setup(project);
      if (!setup?.handle)
        throw new RuntimeSetupError(setup?.error ?? "Failed to create Maa instance");
      this.active = { handle: setup.handle, task };
      try {
        const succeeded = await this.request("postTask", setup.handle, task, []);
        this.log({
          level: succeeded ? "info" : "error",
          message: `Task ${task} ${succeeded ? "finished" : "failed"}`,
          source: "maa-runtime",
        });
      } finally {
        if (!this.options.daemon) {
          await this.request("destroyInstance", setup.handle).catch(() => {});
        }
        if (this.active?.handle === setup.handle) this.active = null;
      }
    } finally {
      this.running = null;
    }
  }

  async screenshot(project: RuntimeProject) {
    if (this.active) {
      const image = await this.request<string>("getScreencap", this.active.handle);
      if (!image) throw new Error("Failed to take screenshot");
      const size = pngDimensions(image);
      return { image, roi: [0, 0, size.width, size.height] };
    }
    if (this.running) throw new Error(`Task ${this.running} is still starting`);

    this.running = "screenshot";
    this.log({ level: "info", message: "Taking screenshot", source: "maa-runtime" });
    let handle;
    try {
      await this.ensure(project);
      const setup = await this.setup(project);
      handle = setup?.handle;
      if (!handle) throw new RuntimeSetupError(setup?.error ?? "Failed to create Maa instance");
      const image = await this.request<string>("getScreencap", handle);
      if (!image) throw new Error("Failed to take screenshot");
      const size = pngDimensions(image);
      return { image, roi: [0, 0, size.width, size.height] };
    } finally {
      if (handle && !this.options.daemon) {
        await this.request("destroyInstance", handle).catch(() => {});
      }
      this.running = null;
    }
  }

  async annotatedScreenshot(project: RuntimeProject) {
    const inst = this.active?.handle ?? this.daemonHandle ?? this.trace.currentInst();
    const recoId = this.trace.latestRecoId();
    if (inst && recoId !== null) {
      const result = await this.request<{ draws: string[] } | null>(
        "getRecoDetail",
        inst,
        String(recoId),
      ).catch(() => null);
      const draws = result?.draws ?? [];
      if (draws.length > 0) {
        const image = await this.toPng(draws[draws.length - 1]);
        if (image) return image;
      }
    }
    const shot = await this.screenshot(project);
    return `data:image/png;base64,${shot.image}`;
  }

  async recoDetail(recoId: number): Promise<RecoDetailResult> {
    const inst = this.active?.handle ?? this.daemonHandle ?? this.trace.currentInst();
    if (!inst)
      throw new Error(
        "No live Maa instance; recognition details require a running task or daemon mode",
      );
    const result = await this.request<{
      info: RecoDetailInfo;
      raw: string;
      draws: string[];
    } | null>("getRecoDetail", inst, String(recoId));
    if (!result) throw new Error(`No recognition detail retained for ${recoId}`);
    const images: string[] = [];
    for (const draw of result.draws ?? []) {
      const image = await this.toPng(draw);
      if (image) images.push(image);
    }
    if (images.length === 0 && result.raw) {
      const raw = await this.toPng(result.raw);
      if (raw) images.push(raw);
    }
    return { info: result.info, images };
  }

  private async toPng(dataUrl: string): Promise<string | null> {
    const marker = "base64,";
    const index = dataUrl.indexOf(marker);
    const base64 = index >= 0 ? dataUrl.slice(index + marker.length) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return dataUrl;
    const size =
      buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 ? jpegDimensions(buffer) : null;
    if (!size) return null;
    try {
      const png = await this.request<string>("resize", base64, size.width, size.height);
      return `data:image/png;base64,${png}`;
    } catch {
      return null;
    }
  }

  async cleanVision() {
    if (!this.options.dataDir) throw new Error("init_options.runtime.data_dir is required");
    await rm(path.join(this.options.dataDir, "logs", "vision"), { recursive: true, force: true });
  }

  async stop() {
    if (!this.active) {
      this.log({
        level: "warn",
        message: this.running ? `Task ${this.running} is still starting` : "No Maa task is running",
        source: "maa-runtime",
      });
      return;
    }
    this.log({
      level: "info",
      message: `Stopping task ${this.active.task}`,
      source: "maa-runtime",
    });
    await this.request("postStop", this.active.handle);
  }

  async shutdown() {
    if (this.active) await this.stop().catch(() => {});
    if (this.daemonHandle) await this.destroyDaemon();
    for (const id of this.agents.keys()) this.stopAgent(id);
    this.rpc?.sendNotification(shutdownNoti);
    this.rpc?.dispose();
    this.process?.kill();
    this.server?.close();
    this.rpc = null;
  }

  private async destroyDaemon() {
    if (!this.daemonHandle) return;
    const handle = this.daemonHandle;
    this.daemonHandle = null;
    await this.request("destroyInstance", handle).catch(() => {});
  }
}
