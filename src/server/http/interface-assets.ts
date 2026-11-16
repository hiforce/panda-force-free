import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface InterfaceAssetRepresentation {
  key: string;
  body: Buffer;
  location?: string;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A document identifies its exact styles and bootstrap; an unchanged HTML source must not pin old resources. */
export function createInterfaceAssets(publicDir: string) {
  let ready: ReadonlyMap<string, InterfaceAssetRepresentation> | null = null;
  const cdnPath = join(publicDir, "cdn-manifest.json");
  const cdn = existsSync(cdnPath)
    ? (JSON.parse(readFileSync(cdnPath, "utf8")) as { assets: Record<string, { url: string; sha256: string }> }).assets
    : null;
  const redirects = new Map<string, InterfaceAssetRepresentation>();
  const targets = new Set([join(publicDir, "index.html"), join(publicDir, "auth-bootstrap.js")]);
  return {
    get(file: string) {
      const path = "/" + relative(publicDir, file).replaceAll("\\", "/");
      const asset = cdn?.[path];
      if (asset) {
        let result = redirects.get(file);
        if (!result) {
          result = { key: asset.sha256, body: readFileSync(file), location: asset.url };
          redirects.set(file, result);
        }
        return result;
      }
      if (!targets.has(file)) return undefined;
      ready ??= interfaceRepresentations(publicDir);
      return ready.get(file);
    },
  };
}
function interfaceRepresentations(publicDir: string): ReadonlyMap<string, InterfaceAssetRepresentation> {
  const representations = new Map<string, InterfaceAssetRepresentation>(),
    versions = new Map<string, string>();
  const hash = (url: string) => {
    if (!/^\/[a-zA-Z0-9._-]+\.(?:css|js)$/.test(url)) throw Error("Invalid interface asset path");
    let value = versions.get(url);
    if (!value) {
      value = digest(readFileSync(join(publicDir, url.slice(1))));
      versions.set(url, value);
    }
    return value;
  };
  const bootstrapPath = join(publicDir, "auth-bootstrap.js");
  const bootstrap = Buffer.from(
    readFileSync(bootstrapPath, "utf8").replace(/(["'])\/app\.bundle\.js\1/g, () =>
      JSON.stringify("/app.bundle.js?v=" + hash("/app.bundle.js")),
    ),
  );
  const bootstrapHash = digest(bootstrap);
  representations.set(bootstrapPath, { key: bootstrapHash, body: bootstrap });
  versions.set("/auth-bootstrap.js", bootstrapHash);
  const indexPath = join(publicDir, "index.html");
  const html = readFileSync(indexPath, "utf8").replace(/<(link|script)\b[^>]*>/g, (tag) =>
    tag.replace(
      /\b(href|src)="(\/[a-zA-Z0-9._-]+\.(css|js))"/,
      (_attribute, name: string, url: string, extension: string) => {
        const value = hash(url);
        return `${name}="${url}?v=${value}"${extension === "css" ? ` data-pf-asset-sha256="${value}" integrity="sha256-${Buffer.from(value, "hex").toString("base64")}"` : ""}`;
      },
    ),
  );
  const body = Buffer.from(html);
  representations.set(indexPath, { key: digest(body), body });
  return representations;
}
