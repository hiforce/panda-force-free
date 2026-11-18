import type { RouteContext } from "../../http/router.js";

export interface CreativeByteSelection {
  status: 200 | 206 | 416;
  head: boolean;
  size: number;
  range?: { start: number; end: number };
}
/** Single byte ranges are selected from immutable metadata before object-store IO. */
export function creativeByteSelection(ctx: RouteContext, size: number, digest: string): CreativeByteSelection {
  const head = ctx.req.method === "HEAD",
    range = head ? undefined : ctx.req.headers.range;
  if (!range || (ctx.req.headers["if-range"] && ctx.req.headers["if-range"] !== '"' + digest + '"'))
    return { status: 200, head, size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0,
    end = size - 1;
  if (match && (match[1] || match[2])) {
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
  }
  if (
    !match ||
    (!match[1] && !match[2]) ||
    (!match[1] && Number(match[2]) === 0) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size
  )
    return { status: 416, head: true, size };
  return { status: 206, head, size, range: { start, end } };
}
export function respondCreativeBytes(
  ctx: RouteContext,
  bytes: Uint8Array | undefined,
  mime: string,
  name: string,
  digest: string,
  selection: CreativeByteSelection,
) {
  const range = selection.range,
    length = selection.status === 416 ? 0 : range ? range.end - range.start + 1 : selection.size;
  ctx.res.writeHead(selection.status, {
    "content-type": mime,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
    "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(name),
    "accept-ranges": "bytes",
    etag: '"' + digest + '"',
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "content-length": String(length),
    ...(selection.status === 416
      ? { "content-range": "bytes */" + selection.size }
      : range
        ? { "content-range": `bytes ${range.start}-${range.end}/${selection.size}` }
        : {}),
  });
  ctx.res.end(selection.head ? undefined : bytes);
}
/** Already materialized covers use the same range and response policy as protected originals. */
export function respondCreativeInline(
  ctx: RouteContext,
  bytes: Uint8Array,
  mime: string,
  name: string,
  digest: string,
) {
  const selection = creativeByteSelection(ctx, bytes.length, digest),
    range = selection.range;
  respondCreativeBytes(ctx, range ? bytes.subarray(range.start, range.end + 1) : bytes, mime, name, digest, selection);
}
