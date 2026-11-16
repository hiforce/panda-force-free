import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { CLIENT_BUNDLES } from "../../shared/client-entrypoints.js";
import { CDN_ASSET_TYPES } from "../../shared/cdn-assets.js";
import { isRecord } from "../../shared/records.js";

/** CDN mode is explicit; incomplete compiled output must never become a local-only deployment. */
export function inspectCompiledCdn(publicDir: string, options: { required?: boolean; baseUrl?: string } = {}) {
  const manifestPath = join(publicDir, "cdn-manifest.json");
  if (!existsSync(manifestPath)) {
    if (options.required) throw Error("cdnBuildRequired");
    return null;
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(manifest) || manifest.schema !== 1 || !isRecord(manifest.assets)) throw Error("manifest");
    const assets = manifest.assets;
    for (const path of CLIENT_BUNDLES) if (!isRecord(assets[path])) throw Error("entrypoint");
    const files: string[] = [];
    function walk(prefix = "") {
      for (const entry of readdirSync(join(publicDir, prefix), { withFileTypes: true })) {
        const path = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isSymbolicLink()) throw Error("symlink");
        if (entry.name.startsWith(".") || /\.(?:map|md)$/.test(path)) continue;
        if (["index.html", "manifest.webmanifest", "cdn-manifest.json"].includes(path)) continue;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push("/" + path);
      }
    }
    walk();
    const expected = new Set(files);
    if (Object.keys(assets).length !== expected.size) throw Error("inventory");
    for (const [path, asset] of Object.entries(assets)) {
      if (!expected.has(path) || !isRecord(asset)) throw Error("asset");
      const type = CDN_ASSET_TYPES[extname(path) as keyof typeof CDN_ASSET_TYPES];
      if (!type || asset.type !== type || typeof asset.url !== "string") throw Error("type");
      const url = new URL(asset.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw Error("url");
      if (options.baseUrl && !asset.url.startsWith(options.baseUrl.replace(/\/$/, "") + "/")) throw Error("base");
      const bytes = readFileSync(join(publicDir, path.slice(1)));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        asset.sha256 !== digest ||
        asset.bytes !== bytes.length ||
        !url.pathname.endsWith("/" + digest + extname(path))
      )
        throw Error("digest");
    }
    const html = readFileSync(join(publicDir, "index.html"), "utf8");
    const embedded = html.match(/<script\b[^>]*id=["']pandaStaticAssets["'][^>]*>([\s\S]*?)<\/script>/);
    const urls: unknown = embedded ? JSON.parse(embedded[1]) : null;
    if (!isRecord(urls) || Object.keys(urls).length !== expected.size) throw Error("html");
    for (const [path, asset] of Object.entries(assets)) {
      if (!isRecord(asset) || urls[path] !== asset.url) throw Error("html asset");
    }
    return { assetCount: files.length, assets };
  } catch (cause) {
    throw Error("cdnBuildRequired", { cause });
  }
}
