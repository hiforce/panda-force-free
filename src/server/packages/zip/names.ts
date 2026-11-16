import { crc32 } from "node:zlib";
import { SourceError } from "../../../shared/packages/sources/contracts.js";

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SourceError("invalidArchive");
  }
}
/** Unicode path extras are accepted only when bound to the original header bytes. */
export function zipName(raw: Uint8Array, flags: number, extra: Uint8Array, authoritative?: string): string {
  let unicode: string | null = null;
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let offset = 0; offset < extra.byteLength;) {
    if (offset + 4 > extra.byteLength) throw new SourceError("invalidArchive");
    const id = view.getUint16(offset, true),
      size = view.getUint16(offset + 2, true),
      end = offset + 4 + size;
    if (end > extra.byteLength) throw new SourceError("invalidArchive");
    if (id === 1) throw new SourceError("unsupportedArchive");
    if (id === 0x7075) {
      if (unicode !== null || size < 5 || extra[offset + 4] !== 1 || view.getUint32(offset + 5, true) !== crc32(raw))
        throw new SourceError("invalidArchive");
      unicode = utf8(extra.subarray(offset + 9, end));
    }
    offset = end;
  }
  const primary = flags & 0x800 ? utf8(raw) : raw.every((byte) => byte < 128) ? utf8(raw) : null;
  if (flags & 0x800 && unicode !== null && unicode !== primary) throw new SourceError("invalidArchive");
  const name = unicode ?? authoritative ?? primary;
  if (name === null) throw new SourceError("unsupportedArchive");
  return name;
}
