import { SourceError, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import { SourcePaths } from "../../../shared/packages/sources/paths.js";
import { zipName } from "./names.js";

export interface ZipEntry {
  path: string;
  directory: boolean;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  expanded: number;
  local: number;
  name: Uint8Array;
  symlink?: true;
}
export interface ZipDirectory {
  entries: readonly ZipEntry[];
  offset: number;
}
export function zipTrailer(bytes: Uint8Array, archiveSize = bytes.length) {
  if (bytes.byteLength < 22) throw new SourceError("invalidArchive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new SourceError("invalidArchive");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    size === 0xffffffff ||
    start === 0xffffffff
  )
    throw new SourceError("unsupportedArchive");
  if (start + size !== archiveSize - bytes.length + end) throw new SourceError("invalidArchive");
  return { count, size, start };
}

/** Inspect every central record and declared expansion before decoding any payload. */
export function zipEntries(
  bytes: Uint8Array,
  directory: ReturnType<typeof zipTrailer>,
  limits: SourceLimits,
  allowSymlinks = false,
): ZipDirectory {
  const { start, count, size } = directory;
  if (count > limits.entries) throw new SourceError("sourceTooLarge");
  if (bytes.length !== size) throw new SourceError("invalidArchive");
  const end = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paths = new SourcePaths(limits.entries),
    entries: ZipEntry[] = [];
  let offset = 0,
    total = 0,
    files = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new SourceError("invalidArchive");
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      compressed = view.getUint32(offset + 20, true),
      expanded = view.getUint32(offset + 24, true),
      nameSize = view.getUint16(offset + 28, true),
      extraSize = view.getUint16(offset + 30, true),
      next = offset + 46 + nameSize + extraSize + view.getUint16(offset + 32, true),
      attrs = view.getUint32(offset + 38, true),
      mode = (attrs >>> 16) & 0xf000,
      local = view.getUint32(offset + 42, true);
    if (next > end || !nameSize || nameSize > 4096) throw new SourceError("invalidArchive");
    if (
      flags & ~(0x800 | 8 | 2 | 4) ||
      ![0, 8].includes(method) ||
      view.getUint16(offset + 34, true) ||
      [compressed, expanded, local].includes(0xffffffff) ||
      ![0, 0x8000, 0x4000, ...(allowSymlinks ? [0xa000] : [])].includes(mode)
    )
      throw new SourceError("unsupportedArchive");
    const name = bytes.slice(offset + 46, offset + 46 + nameSize),
      decoded = zipName(name, flags, bytes.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize)),
      directory = decoded.endsWith("/");
    if ((mode === 0x4000 || attrs & 0x10) && !directory) throw new SourceError("invalidArchive");
    if (directory && expanded) throw new SourceError("invalidArchive");
    if (directory && mode === 0xa000) throw new SourceError("invalidArchive");
    const path = paths.add(directory ? decoded.slice(0, -1) : decoded, directory);
    if (!directory) {
      files++;
      total += expanded;
      if (files > limits.files || expanded > limits.fileBytes || total > limits.totalBytes)
        throw new SourceError("sourceTooLarge");
    }
    entries.push({
      path,
      directory,
      method,
      flags,
      crc: view.getUint32(offset + 16, true),
      compressed,
      expanded,
      local,
      name,
      ...(mode === 0xa000 ? { symlink: true as const } : {}),
    });
    offset = next;
  }
  if (offset !== end) throw new SourceError("invalidArchive");
  return { entries, offset: start };
}

export function zipDirectory(bytes: Uint8Array, limits: SourceLimits, allowSymlinks = false): ZipDirectory {
  if (bytes.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  const directory = zipTrailer(bytes);
  return zipEntries(
    bytes.subarray(directory.start, directory.start + directory.size),
    directory,
    limits,
    allowSymlinks,
  );
}
