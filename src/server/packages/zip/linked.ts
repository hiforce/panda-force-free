import { SourceError, type SourceLimits, type SourceResource } from "../../../shared/packages/sources/contracts.js";
import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { zipDirectory } from "./headers.js";
import { zipPayloads } from "./layout.js";
import { decodeZipPayload } from "./payload.js";

/** Linked ZIP intake preserves raw targets and the original archive, without creating filesystem links. */
export async function readLinkedZip(bytes: Uint8Array, limits: SourceLimits, signal?: AbortSignal) {
  const payloads = zipPayloads(bytes, zipDirectory(bytes, limits, true)),
    resources: SourceResource[] = [],
    links: SourceResource[] = [];
  for (const payload of payloads) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    if (payload.entry.directory) continue;
    const value = { path: payload.entry.path, bytes: await decodeZipPayload(bytes, payload, signal, true) };
    (payload.entry.symlink ? links : resources).push(value);
  }
  return {
    tree: await ImmutableSourceTree.create(resources, limits),
    links: await ImmutableSourceTree.create(links, limits),
  };
}
