import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";

export class RasterCoverBusyError extends Error {}

/** One bounded renderer produces inert thumbnails; package paths and permissions belong to the caller. */
export class RasterCoverRenderer {
  private cache = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer>>();
  private cacheBytes = 0;
  private pendingBytes = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  async render(input: Uint8Array): Promise<Buffer> {
    if (!input.length || input.length > 4 * 1024 * 1024) throw Error("Invalid cover size");
    const bytes = Buffer.from(input),
      key = createHash("sha256").update(bytes).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return Buffer.from(cached);
    const running = this.pending.get(key);
    if (running) return Buffer.from(await running);
    if (this.pending.size >= 18 || this.pendingBytes + bytes.length > 16 * 1024 * 1024)
      throw new RasterCoverBusyError("Cover renderer busy");
    this.pendingBytes += bytes.length;
    const operation = this.decode(bytes);
    this.pending.set(key, operation);
    try {
      const result = await operation;
      while (this.cache.size && (this.cache.size >= 32 || this.cacheBytes + result.length > 8 * 1024 * 1024)) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.length;
        this.cache.delete(oldest);
      }
      this.cache.set(key, result);
      this.cacheBytes += result.length;
      return Buffer.from(result);
    } finally {
      this.pending.delete(key);
      this.pendingBytes -= bytes.length;
    }
  }
  private async decode(bytes: Buffer) {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "error" }),
        info = await image.metadata();
      if (!info.format || !["png", "jpeg", "webp"].includes(info.format) || (info.pages ?? 1) > 1)
        throw Error("Unsupported cover format");
      return await image.rotate().resize(960, 600, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** This response is used only after the authenticated adapter resolves an exact installed package. */
export function respondRasterCover(req: IncomingMessage, res: ServerResponse, bytes: Buffer) {
  const etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
  const headers = {
    "content-type": "image/webp",
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "content-length": String(bytes.length) });
  res.end(bytes);
}
