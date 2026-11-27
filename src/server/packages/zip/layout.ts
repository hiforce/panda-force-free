import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { ZipDirectory, ZipEntry } from "./headers.js";
import { zipName } from "./names.js";

export interface ZipPayload {
  entry: ZipEntry;
  start: number;
  end: number;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function localLength(fixed: Uint8Array) {
  if (fixed.length !== 30) throw new SourceError("invalidArchive");
  const data = view(fixed);
  if (data.getUint32(0, true) !== 0x04034b50) throw new SourceError("invalidArchive");
  return 30 + data.getUint16(26, true) + data.getUint16(28, true);
}

function localPayload(entry: ZipEntry, bytes: Uint8Array, limit: number) {
  const data = view(bytes);
  const length = localLength(bytes.subarray(0, 30));
  const start = entry.local + length;
  const end = start + entry.compressed;
  if (
    bytes.length !== length ||
    end > limit ||
    data.getUint16(6, true) !== entry.flags ||
    data.getUint16(8, true) !== entry.method
  )
    throw new SourceError("invalidArchive");

  const nameEnd = 30 + data.getUint16(26, true);
  const name = bytes.subarray(30, nameEnd);
  if (name.byteLength !== entry.name.byteLength || !name.every((byte, index) => byte === entry.name[index]))
    throw new SourceError("invalidArchive");
  const path = entry.path + (entry.directory ? "/" : "");
  if (zipName(name, entry.flags, bytes.subarray(nameEnd), path) !== path) throw new SourceError("invalidArchive");

  const crc = data.getUint32(14, true);
  const compressed = data.getUint32(18, true);
  const expanded = data.getUint32(22, true);
  const exact = (value: number, expected: number) => value === expected || (!value && entry.flags & 8);
  if (!exact(crc, entry.crc) || !exact(compressed, entry.compressed) || !exact(expanded, entry.expanded))
    throw new SourceError("invalidArchive");
  return { entry, start, end };
}

function descriptorSize(bytes: Uint8Array, entry: ZipEntry) {
  const data = view(bytes);
  const matches = (position: number) =>
    position + 12 <= bytes.length &&
    data.getUint32(position, true) === entry.crc &&
    data.getUint32(position + 4, true) === entry.compressed &&
    data.getUint32(position + 8, true) === entry.expanded;
  if (matches(0)) return 12;
  if (matches(4) && data.getUint32(0, true) === 0x08074b50) return 16;
  throw new SourceError("invalidArchive");
}

/** Headers and payloads must describe one contiguous archive with no hidden or overlapping local entries. */
export function zipPayloads(bytes: Uint8Array, directory: ZipDirectory): ZipPayload[] {
  const payloads: ZipPayload[] = [];
  let offset = 0;
  for (const entry of [...directory.entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== offset || offset + 30 > directory.offset) throw new SourceError("invalidArchive");
    const length = localLength(bytes.subarray(offset, offset + 30));
    const payload = localPayload(entry, bytes.subarray(offset, offset + length), directory.offset);
    offset = payload.end;
    if (entry.flags & 8)
      offset += descriptorSize(bytes.subarray(offset, Math.min(offset + 16, directory.offset)), entry);
    payloads.push(payload);
  }
  if (offset !== directory.offset) throw new SourceError("invalidArchive");
  return payloads;
}

export async function zipRangePayloads(
  read: (position: number, length: number) => Promise<Uint8Array>,
  directory: ZipDirectory,
): Promise<ZipPayload[]> {
  const payloads: ZipPayload[] = [];
  let offset = 0;
  for (const entry of [...directory.entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== offset || offset + 30 > directory.offset) throw new SourceError("invalidArchive");
    const fixed = await read(offset, 30);
    const length = localLength(fixed);
    if (offset + length > directory.offset) throw new SourceError("invalidArchive");
    const prefix = new Uint8Array(length);
    prefix.set(fixed);
    if (length > 30) prefix.set(await read(offset + 30, length - 30), 30);
    const payload = localPayload(entry, prefix, directory.offset);
    offset = payload.end;
    if (entry.flags & 8) offset += descriptorSize(await read(offset, Math.min(16, directory.offset - offset)), entry);
    payloads.push(payload);
  }
  if (offset !== directory.offset) throw new SourceError("invalidArchive");
  return payloads;
}
