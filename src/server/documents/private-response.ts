import type { ServerResponse } from "node:http";

/** Authorization belongs to the caller; this policy serves private document assets only. */
export function respondPrivateDocumentAsset(
  response: ServerResponse,
  asset: { mime: string; name: string },
  bytes: Uint8Array,
) {
  response.writeHead(200, {
    "content-type": asset.mime,
    "content-length": String(bytes.length),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(asset.name),
  });
  response.end(bytes);
}
