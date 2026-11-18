import { createHash } from "node:crypto";
import sharp from "sharp";
import { isRecord } from "../../../../shared/records.js";
import { ImageRenderError } from "./image-contracts.js";

export const imageDigest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export async function decodedImage(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new ImageRenderError("invalidResult");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 }),
      info = await image.metadata();
    if (!info.width || !info.height || (info.pages ?? 1) !== 1 || !["png", "jpeg", "webp"].includes(info.format ?? ""))
      throw new ImageRenderError("invalidResult");
    // A format header alone is not proof that a generated raster can be decoded.
    await image.raw().toBuffer();
    return {
      width: info.width,
      height: info.height,
      mime: ("image/" + info.format) as "image/png" | "image/jpeg" | "image/webp",
    };
  } catch (error) {
    if (error instanceof ImageRenderError) throw error;
    throw new ImageRenderError("invalidResult");
  }
}
/** Only original bytes from a completed native item are accepted; savedPath and fileId never grant filesystem access. */
export async function nativeImageResult(turn: unknown) {
  if (!isRecord(turn) || turn.status !== "completed" || !Array.isArray(turn.items))
    throw new ImageRenderError("invalidResult");
  const items = turn.items.filter((item) => isRecord(item) && item.type === "imageGeneration");
  if (items.length !== 1) throw new ImageRenderError("invalidResult");
  const item = items[0]!;
  if (!isRecord(item) || item.status !== "completed" || item.failure || typeof item.result !== "string")
    throw new ImageRenderError("invalidResult");
  const encoded = item.result;
  if (!encoded.length || encoded.length > 44_739_244 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new ImageRenderError("invalidResult");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new ImageRenderError("invalidResult");
  return { bytes, digest: imageDigest(bytes), size: bytes.length, ...(await decodedImage(bytes)) };
}
