import sharp from "sharp";
import type { CreativeAssetKind } from "../../../shared/creative/assets.js";
import { creativeFileExtension, creativeFilePreview } from "../../../shared/creative/file-types.js";
import { DocumentError } from "../../documents/errors.js";

/** Validate passive originals without executing user content or starting a caller-selected process. */
export async function validateCreativeMedia(kind: CreativeAssetKind, name: string, input: Uint8Array) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength),
    extension = creativeFileExtension(name);
  if (kind === "file" && ["image", "video"].includes(creativeFilePreview(name).kind))
    return validateCreativeMedia(creativeFilePreview(name).kind as "image" | "video", name, input);
  if (kind === "image") {
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    const expected: Record<string, string[]> = {
      jpg: ["jpeg"],
      jpeg: ["jpeg"],
      png: ["png"],
      webp: ["webp"],
      gif: ["gif"],
      avif: ["avif", "heif"],
    };
    if (
      !metadata.width ||
      !metadata.height ||
      !expected[extension]?.includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) > 200
    )
      throw new DocumentError("invalidInput");
  } else if (kind === "video") {
    if (extension === "webm") {
      if (bytes.readUInt32BE(0) !== 0x1a45dfa3 || !bytes.subarray(0, 4096).includes(Buffer.from("webm")))
        throw new DocumentError("invalidInput");
      return;
    }
    const boxes = new Set<string>();
    for (let offset = 0, count = 0; offset < bytes.length; count++) {
      if (count > 10000 || offset + 8 > bytes.length) throw new DocumentError("invalidInput");
      let length = bytes.readUInt32BE(offset),
        header = 8;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (length === 1) {
        if (offset + 16 > bytes.length) throw new DocumentError("invalidInput");
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(bytes.length)) throw new DocumentError("invalidInput");
        length = Number(large);
        header = 16;
      } else if (!length) length = bytes.length - offset;
      if (length < header || offset + length > bytes.length) throw new DocumentError("invalidInput");
      boxes.add(type);
      offset += length;
    }
    if (!boxes.has("moov") || !boxes.has("mdat") || (extension !== "mov" && !boxes.has("ftyp")))
      throw new DocumentError("invalidInput");
  } else if (kind === "file" && extension === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new DocumentError("invalidInput");
}
