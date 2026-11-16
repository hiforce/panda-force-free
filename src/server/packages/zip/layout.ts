import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { ZipDirectory, ZipEntry } from "./headers.js";
import { zipName } from "./names.js";

export interface ZipPayload {
  entry: ZipEntry;
  start: number;
  end: number;
}
/** Headers and payloads must describe one contiguous archive with no hidden or overlapping local entries. */
export function zipPayloads(bytes: Uint8Array, directory: ZipDirectory): ZipPayload[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    payloads: ZipPayload[] = [];
  let offset = 0;
  for (const entry of [...directory.entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== offset || offset + 30 > directory.offset || view.getUint32(offset, true) !== 0x04034b50)
      throw new SourceError("invalidArchive");
    const nameSize = view.getUint16(offset + 26, true),
      extraSize = view.getUint16(offset + 28, true),
      start = offset + 30 + nameSize + extraSize,
      end = start + entry.compressed;
    if (
      start > directory.offset ||
      end > directory.offset ||
      view.getUint16(offset + 6, true) !== entry.flags ||
      view.getUint16(offset + 8, true) !== entry.method
    )
      throw new SourceError("invalidArchive");
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize);
    if (name.byteLength !== entry.name.byteLength || !name.every((byte, index) => byte === entry.name[index]))
      throw new SourceError("invalidArchive");
    const decoded = zipName(
      name,
      entry.flags,
      bytes.subarray(offset + 30 + nameSize, start),
      entry.path + (entry.directory ? "/" : ""),
    );
    if (decoded !== entry.path + (entry.directory ? "/" : "")) throw new SourceError("invalidArchive");
    const crc = view.getUint32(offset + 14, true),
      compressed = view.getUint32(offset + 18, true),
      expanded = view.getUint32(offset + 22, true);
    if (entry.flags & 8) {
      if (
        (crc && crc !== entry.crc) ||
        (compressed && compressed !== entry.compressed) ||
        (expanded && expanded !== entry.expanded)
      )
        throw new SourceError("invalidArchive");
      const matches = (position: number) =>
        position + 12 <= directory.offset &&
        view.getUint32(position, true) === entry.crc &&
        view.getUint32(position + 4, true) === entry.compressed &&
        view.getUint32(position + 8, true) === entry.expanded;
      const descriptor = matches(end)
        ? end
        : end + 4 <= directory.offset && view.getUint32(end, true) === 0x08074b50 && matches(end + 4)
          ? end + 4
          : -1;
      if (descriptor < 0) throw new SourceError("invalidArchive");
      offset = descriptor + 12;
    } else {
      if (crc !== entry.crc || compressed !== entry.compressed || expanded !== entry.expanded)
        throw new SourceError("invalidArchive");
      offset = end;
    }
    payloads.push({ entry, start, end });
  }
  if (offset !== directory.offset) throw new SourceError("invalidArchive");
  return payloads;
}
