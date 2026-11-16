import { zip, type Zippable } from "fflate";
import {
  DEFAULT_SOURCE_LIMITS,
  SourceError,
  sourceLimits,
  type SourceResource,
  type SourceLimits,
} from "../../../shared/packages/sources/contracts.js";
import { SourcePaths } from "../../../shared/packages/sources/paths.js";

/** Export only explicit regular files; caller bytes are captured before the asynchronous ZIP writer starts. */
export async function writeSourceZip(
  input: Iterable<SourceResource>,
  options: SourceLimits = DEFAULT_SOURCE_LIMITS,
): Promise<Uint8Array> {
  const limits = sourceLimits(options),
    paths = new SourcePaths(limits.entries),
    archive: Zippable = Object.create(null),
    attributes = { level: 0 as const, mtime: new Date("2000-01-01T00:00:00Z"), attrs: (0o100644 << 16) >>> 0, os: 3 };
  let count = 0,
    total = 0;
  for (const value of input) {
    if (!value || !(value.bytes instanceof Uint8Array)) throw new SourceError("invalidSource");
    const path = paths.add(value.path);
    total += value.bytes.length;
    if (++count > limits.files || value.bytes.length > limits.fileBytes || total > limits.totalBytes)
      throw new SourceError("sourceTooLarge");
    archive[path] = [new Uint8Array(value.bytes), attributes];
  }
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(archive, { level: 0 }, (error, value) => (error ? reject(error) : resolve(value))),
  );
  if (bytes.length > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  return bytes;
}
