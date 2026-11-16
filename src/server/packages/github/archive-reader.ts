import { SourceError, type SourceLimits, type PackageSourceFile } from "../../../shared/packages/sources/contracts.js";
import { gitBlobDigest, type PackageSourceReader } from "../../../shared/packages/sources/reader.js";
import { zipDirectory } from "../zip/headers.js";
import { zipPayloads } from "../zip/layout.js";
import { decodeZipPayload } from "../zip/payload.js";

/** Git metadata remains authoritative when export-ignore or export-subst changes an archive projection. */
export async function githubArchiveReader(
  source: PackageSourceReader,
  selected: readonly PackageSourceFile[],
  input: Uint8Array,
  limits: SourceLimits,
  signal?: AbortSignal,
  admitFallback?: (files: number) => void,
): Promise<PackageSourceReader> {
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  if (source.origin.kind !== "github") throw new SourceError("invalidSource");
  const bytes = new Uint8Array(input),
    payloads = zipPayloads(bytes, zipDirectory(bytes, { ...limits, entries: limits.entries + 1 }, true)),
    wrapper = payloads[0]?.entry.path.split("/")[0];
  if (!wrapper || payloads.some(({ entry }) => entry.path !== wrapper && !entry.path.startsWith(wrapper + "/")))
    throw new SourceError("invalidArchive");
  const prefix = wrapper + "/" + (source.origin.root ? source.origin.root + "/" : ""),
    entries = new Map(payloads.map((payload) => [payload.entry.path, payload])),
    captured = new Map<string, Uint8Array>();
  for (const file of selected) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    const payload = entries.get(prefix + file.path);
    if (!payload) continue;
    const link = source.links?.some((entry) => entry.path === file.path) ?? false;
    if (!!payload.entry.symlink !== link || payload.entry.directory) throw new SourceError("sourceChanged");
    const value = await decodeZipPayload(bytes, payload, signal, link);
    if (value.byteLength === file.bytes && (await gitBlobDigest(value)) === file.integrity.value)
      captured.set(file.path, new Uint8Array(value));
  }
  admitFallback?.(selected.length - captured.size);
  return Object.freeze({
    origin: source.origin,
    files: source.files,
    unavailable: source.unavailable,
    ...(source.links ? { links: source.links } : {}),
    async read(path: string, current?: AbortSignal) {
      if (signal?.aborted || current?.aborted) throw new SourceError("sourceCancelled");
      const value = captured.get(path);
      return value ? new Uint8Array(value) : source.read(path, current);
    },
  });
}
