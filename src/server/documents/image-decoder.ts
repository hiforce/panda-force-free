import { createHash } from "node:crypto";
import sharp from "sharp";
import { DocumentError } from "./errors.js";
import { text } from "./validation.js";

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
export function imageUploadName(value: unknown): string {
  const name = text(value, 240);
  if (/[\\/]/.test(name) || name.startsWith(".")) throw new DocumentError("invalidInput");
  return name;
}
export function imageUploadBytes(input: Uint8Array): Buffer {
  if (!input.byteLength || input.byteLength > MAX_ASSET_BYTES) throw new DocumentError("assetTooLarge", 413);
  return Buffer.from(input);
}

/** Legacy ingestion and file-backed uploads share bounded, detached byte validation without owning storage. */
export class DocumentImageDecoder {
  private decoding = 0;
  async decode(value: string, input: Uint8Array) {
    const name = imageUploadName(value),
      bytes = imageUploadBytes(input);
    if (this.decoding >= 2) throw new DocumentError("busy", 429);
    this.decoding++;
    let width: number, height: number, mime: string;
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "error" }),
        info = await image.metadata();
      if (!info.width || !info.height || !info.format || !formats[info.format] || (info.pages ?? 1) > 1)
        throw Error("Unsupported image");
      await image.stats();
      width = info.width;
      height = info.height;
      mime = formats[info.format]!;
    } catch {
      throw new DocumentError("invalidImage");
    } finally {
      this.decoding--;
    }
    return {
      name,
      bytes,
      mime,
      width,
      height,
      size: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}
