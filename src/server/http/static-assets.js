import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Only resolved application assets enter this cache; API and session data do not.
const assets = new Map();
/** @param {import("./interface-assets.js").InterfaceAssetRepresentation | undefined} [representation] */
export function serveStaticAsset(req, res, file, contentType, representation) {
  const stat = statSync(file);
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${representation?.key || ""}`;
  let asset = assets.get(file);
  if (!asset || asset.signature !== signature) {
    const body = representation?.body || readFileSync(file);
    const version = createHash("sha256").update(body).digest("hex");
    asset = { signature, body, version, etag: `W/"${version}"` };
    assets.set(file, asset);
  }
  const requestedVersion = new URL(req.url || "/", "http://static.invalid").searchParams.get("v");
  if (
    /^(?:text\/(?:css|javascript)|application\/javascript)/.test(contentType) &&
    /^[a-f0-9]{64}$/.test(requestedVersion || "") &&
    requestedVersion !== asset.version
  ) {
    res.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : "The interface version changed. Reload the page.");
    return;
  }
  if (representation?.location) {
    const target = new URL(representation.location);
    const retry = new URL(req.url || "/", "http://static.invalid").searchParams.get("retry");
    if (retry === "1") target.searchParams.set("retry", retry);
    res.writeHead(302, { location: target.href, "cache-control": "private, no-cache" });
    res.end();
    return;
  }
  const headers = {
    "content-type": contentType,
    "cache-control": "private, no-cache",
    etag: asset.etag,
    vary: "Accept-Encoding",
  };
  const matches = String(req.headers["if-none-match"] || "")
    .split(",")
    .map((value) => value.trim());
  if (
    ["GET", "HEAD"].includes(req.method) &&
    (matches.includes("*") || matches.some((value) => value.replace(/^W\//, "") === asset.etag.replace(/^W\//, "")))
  ) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let body = asset.body;
  const gzip = String(req.headers["accept-encoding"] || "")
    .split(",")
    .some((value) => {
      const [encoding, ...parameters] = value.trim().split(";");
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      return encoding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
    });
  if (gzip && body.length > 1024 && /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/.test(contentType)) {
    asset.gzip ||= gzipSync(body);
    body = asset.gzip;
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
