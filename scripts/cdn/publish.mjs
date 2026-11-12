import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, posix, relative } from "node:path";
import { parse, parseExpressionAt } from "acorn";

const types = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function collectAssets(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Symlink in static output: " + path);
      if (entry.name.startsWith(".") || path.endsWith(".map") || path.endsWith(".md")) return [];
      if (entry.isDirectory()) return collectAssets(directory, path);
      if (["index.html", "manifest.webmanifest"].includes(path)) return [];
      if (!types[extname(path)]) throw new Error("Unsupported static output type: " + path);
      return [["/" + path, readFileSync(join(directory, path))]];
    });
}

function references(path, text, assets) {
  const result = [];
  const add = (start, end, value, encode) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return;
    const clean = value.split(/[?#]/)[0];
    const target = clean.startsWith("/") ? clean : posix.resolve(posix.dirname(path), clean);
    if (assets.has(target))
      result.push({
        start,
        end,
        target,
        encode,
        suffix: value.includes("#") ? "#" + value.split("#").slice(1).join("#") : "",
      });
    else if (
      /\.(?:m?js|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|avif)(?:[?#]|$)/i.test(value) &&
      !clean.startsWith("/api/") &&
      (value.startsWith("/") || value.startsWith("."))
    )
      throw new Error(`Missing static dependency ${value} in ${path}`);
  };
  if (/\.(?:m?js|json)$/.test(path)) {
    if (path.endsWith(".json")) JSON.parse(text);
    const tree = path.endsWith(".json")
      ? parseExpressionAt(text, 0, { ecmaVersion: "latest" })
      : parse(text, { ecmaVersion: "latest", sourceType: "module" });
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "Literal" && typeof node.value === "string")
        add(node.start, node.end, node.value, JSON.stringify);
      if (
        node.type === "TemplateLiteral" &&
        node.expressions.length === 0 &&
        typeof node.quasis[0].value.cooked === "string"
      )
        add(node.start, node.end, node.quasis[0].value.cooked, JSON.stringify);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    };
    walk(tree);
  } else if (/\.css$/.test(path)) {
    for (const match of text.matchAll(/url\(\s*(["']?)([^\s"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g)) {
      const value = match[2] || match[4];
      const start = match.index + match[0].indexOf(value);
      add(start, start + value.length, value, (url) => url);
    }
  } else if (/\.svg$/.test(path)) {
    for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      const start = match.index + match[0].indexOf(match[1]);
      add(start, start + match[1].length, match[1], (url) => url);
    }
  }
  return result;
}

/** Dependencies are finalized first, so hashes always describe the delivered bytes. */
export async function publishAssets({ assets, storage, baseUrl, prefix, now = new Date(), verify = verifyCdn }) {
  const records = {},
    pending = new Map(),
    content = new Map(),
    graph = new Map();
  for (const [path, bytes] of assets)
    graph.set(path, /\.(?:m?js|css|svg|json)$/.test(path) ? references(path, bytes.toString("utf8"), assets) : []);
  const visited = new Set(),
    active = new Set();
  const visit = (path) => {
    if (active.has(path)) throw new Error("Cyclic static imports require bundling into one module: " + path);
    if (visited.has(path)) return;
    active.add(path);
    for (const edit of graph.get(path)) visit(edit.target);
    active.delete(path);
    visited.add(path);
  };
  for (const path of assets.keys()) visit(path);
  let uploaded = 0,
    reused = 0;
  const month = now.toISOString().slice(0, 7).replace("-", "/");
  const finalize = (path) => {
    if (!pending.has(path)) pending.set(path, build(path));
    return pending.get(path);
  };
  const build = async (path) => {
    const original = assets.get(path);
    let body = original;
    if (/\.(?:m?js|css|svg|json)$/.test(path)) {
      let text = original.toString("utf8");
      const edits = graph.get(path).map((edit) => ({ ...edit }));
      for (const edit of edits) edit.url = (await finalize(edit.target)).url + edit.suffix;
      for (const edit of edits.sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.encode(edit.url) + text.slice(edit.end);
      body = Buffer.from(text);
    }
    const digest = sha256(body),
      type = types[extname(path)];
    const contentKey = digest + extname(path);
    if (content.has(contentKey)) {
      records[path] = await content.get(contentKey);
      return records[path];
    }
    const upload = async () => {
      const indexKey = `${prefix}/_index/${digest}${extname(path)}.json`;
      const existing = await storage.get(indexKey);
      let key;
      if (existing) {
        const record = JSON.parse(existing.toString());
        if (
          record.sha256 !== digest ||
          record.type !== type ||
          !new RegExp(`^${prefix}/\\d{4}/\\d{2}/${digest}\\${extname(path)}$`).test(record.key)
        )
          throw new Error("Invalid CDN hash index for " + path);
        key = record.key;
        const stored = await storage.get(key);
        if (!stored || sha256(stored) !== digest) throw new Error("Stored CDN object differs from hash index: " + path);
        reused++;
      } else {
        key = `${prefix}/${month}/${digest}${extname(path)}`;
        await storage.put(key, body, type);
        const stored = await storage.get(key);
        if (!stored || sha256(stored) !== digest) throw new Error("S3 upload hash mismatch: " + path);
        uploaded++;
      }
      const url = `${baseUrl}/${key}`;
      await verify(url, body, type);
      if (!existing) {
        const index = Buffer.from(JSON.stringify({ key, sha256: digest, type }));
        await storage.put(indexKey, index, "application/json", false);
        if (!(await storage.get(indexKey))?.equals(index))
          throw new Error("CDN hash index verification failed: " + path);
      }
      return { url, key, sha256: digest, bytes: body.length, type };
    };
    content.set(contentKey, upload());
    records[path] = await content.get(contentKey);
    return records[path];
  };
  const paths = [...assets.keys()].sort();
  for (let offset = 0; offset < paths.length; offset += 6)
    await Promise.all(paths.slice(offset, offset + 6).map(finalize));
  return {
    schema: 1,
    assets: Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b))),
    uploaded,
    reused,
  };
}

export async function verifyCdn(url, expected, type) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Origin: "https://cdn-verification.invalid", Priority: "u=1" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== sha256(expected))
        throw new Error("content");
      if (response.headers.get("content-type")?.split(";")[0] !== type.split(";")[0]) throw new Error("MIME");
      if (response.headers.get("access-control-allow-origin") !== "*") throw new Error("CORS");
      return;
    } catch {
      if (attempt === 2) throw new Error("CDN byte, MIME or CORS verification failed: " + url);
      await Bun.sleep(500 * 2 ** attempt);
    }
  }
}

export function writeCdnOutput({ source, output, manifest }) {
  if (![relative(source, output), relative(output, source)].every((path) => path.startsWith("..")))
    throw new Error("CDN output must not overlap source assets");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(source, output, { recursive: true, filter: (path) => relative(source, path) !== "index.html" });
  const urls = Object.fromEntries(Object.entries(manifest.assets).map(([path, record]) => [path, record.url]));
  let html = readFileSync(join(source, "index.html"), "utf8").replace(
    /\b(src|href)=(['"])([^'"]+)\2/g,
    (all, name, quote, value) =>
      urls[value.split(/[?#]/)[0]] ? `${name}=${quote}${urls[value.split(/[?#]/)[0]]}${quote}` : all,
  );
  const data = JSON.stringify(urls).replaceAll("<", "\\u003c");
  if (!html.includes("<head>")) throw new Error("Static HTML is missing its head element");
  html = html.replace("<head>", `<head>\n<script type="application/json" id="pandaStaticAssets">${data}</script>`);
  // The web-app manifest stays on the application origin to preserve installation scope.
  const webManifest = JSON.parse(readFileSync(join(source, "manifest.webmanifest"), "utf8"));
  for (const icon of webManifest.icons || []) icon.src = urls[icon.src.split(/[?#]/)[0]] || icon.src;
  writeFileSync(join(output, "manifest.webmanifest"), JSON.stringify(webManifest, null, 2) + "\n");
  writeFileSync(join(output, "cdn-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(output, "index.html"), html);
}
