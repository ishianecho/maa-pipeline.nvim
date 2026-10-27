import path from "node:path";
import { pathToFileURL } from "node:url";

const options = JSON.parse(Buffer.from(process.argv[2], "base64").toString()) as {
  module: string;
  recoImageCacheLimit?: number;
};

await import(
  pathToFileURL(path.join(options.module, "@maaxyz/maa-node/dist/index-client.js")).toString()
);
const maa = (globalThis as { maa?: { Global: { reco_image_cache_limit: number } } }).maa;
if (maa) {
  maa.Global.reco_image_cache_limit = String(
    options.recoImageCacheLimit ?? 64,
  ) as unknown as number;
}

await import("@nekosu/maa-server");
