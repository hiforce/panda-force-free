import { contentSha256 } from "../../../shared/packages/digest.js";
import {
  SourceError,
  sourceLimits,
  type SourceLimits,
  type SourceEntryPolicy,
} from "../../../shared/packages/sources/contracts.js";
import type { PackageSourceReader } from "../../../shared/packages/sources/reader.js";
import { readSourceZip } from "./read.js";
import { readLinkedZip } from "./linked.js";

export interface ZipSourceReader extends PackageSourceReader {
  readArchive(): Uint8Array;
}
export async function openZipSource(
  input: Uint8Array,
  name: unknown,
  options?: SourceLimits,
  signal?: AbortSignal,
  policy: SourceEntryPolicy = "regular-only/v1",
): Promise<ZipSourceReader> {
  const limits = sourceLimits(options);
  if (!(input instanceof Uint8Array) || input.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  if (typeof name !== "string" || !name.trim() || name.length > 160 || /[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(name))
    throw new SourceError("invalidSource");
  const bytes = new Uint8Array(input),
    source =
      policy === "logical-links/v2"
        ? await readLinkedZip(bytes, limits, signal)
        : { tree: await readSourceZip(bytes, limits, signal), links: undefined },
    { tree, links } = source,
    archiveSha256 = await contentSha256(bytes);
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  return Object.freeze({
    origin: Object.freeze({ kind: "zip-upload" as const, name, archiveSha256 }),
    files: Object.freeze(
      tree.files.map((file) =>
        Object.freeze({
          path: file.path,
          bytes: file.bytes,
          integrity: Object.freeze({ algorithm: "sha256" as const, value: file.sha256 }),
        }),
      ),
    ),
    ...(links
      ? {
          links: Object.freeze(
            links.files.map((file) =>
              Object.freeze({
                path: file.path,
                bytes: file.bytes,
                integrity: Object.freeze({ algorithm: "sha256" as const, value: file.sha256 }),
              }),
            ),
          ),
        }
      : {}),
    unavailable: Object.freeze(
      (links?.files ?? []).map((file) => Object.freeze({ path: file.path, reason: "symlink" as const })),
    ),
    async read(path: string, current?: AbortSignal) {
      if (current?.aborted) throw new SourceError("sourceCancelled");
      return links?.has(path) ? links.read(path) : tree.read(path);
    },
    readArchive: () => new Uint8Array(bytes),
  });
}
