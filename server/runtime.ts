import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const options = JSON.parse(Buffer.from(process.argv[2], "base64").toString()) as {
  module?: string;
  binding?: string;
  recoImageCacheLimit?: number;
};

if (options.binding) {
  const root = await mkdtemp(path.join(tmpdir(), "maa-pipeline-"));
  const wrapper = path.join(root, "@maaxyz", "maa-node", "dist", "index-client.js");
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(
    wrapper,
    `globalThis.maa = require(${JSON.stringify(path.join(options.binding, "MaaNode.node"))});\n`,
  );
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
  options.module = root;
  process.argv[2] = Buffer.from(JSON.stringify(options)).toString("base64");
}

await import(
  pathToFileURL(path.join(options.module!, "@maaxyz/maa-node/dist/index-client.js")).toString()
);
const maa = (globalThis as { maa?: { Global: { reco_image_cache_limit: number } } }).maa;
if (maa) {
  maa.Global.reco_image_cache_limit = String(
    options.recoImageCacheLimit ?? 64,
  ) as unknown as number;
}

await import("@nekosu/maa-server");
