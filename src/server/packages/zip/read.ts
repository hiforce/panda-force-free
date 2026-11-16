import {
  SourceError,
  sourceLimits,
  type SourceLimits,
  type SourceResource,
} from "../../../shared/packages/sources/contracts.js";
import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { zipDirectory } from "./headers.js";
import { zipPayloads } from "./layout.js";
import { decodeZipPayload } from "./payload.js";

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new SourceError("sourceCancelled");
};
/** Bounded asynchronous inflation never writes archive paths to the host filesystem. */
export async function readSourceZip(
  input: Uint8Array,
  options?: SourceLimits,
  signal?: AbortSignal,
): Promise<ImmutableSourceTree> {
  const limits = sourceLimits(options);
  if (!(input instanceof Uint8Array)) throw new SourceError("invalidArchive");
  if (input.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  cancelled(signal);
  const bytes = new Uint8Array(input),
    payloads = zipPayloads(bytes, zipDirectory(bytes, limits)),
    resources: SourceResource[] = [];
  for (const payload of payloads) {
    cancelled(signal);
    const { entry } = payload,
      decoded = await decodeZipPayload(bytes, payload, signal);
    if (!entry.directory) resources.push({ path: entry.path, bytes: decoded });
  }
  const tree = await ImmutableSourceTree.create(resources, limits);
  cancelled(signal);
  return tree;
}
