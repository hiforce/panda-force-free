import type { SavedSourceMetadata } from "../../shared/content-sources/contracts.js";
import { ProjectContentError } from "../project-content/errors.js";
import { stableJson } from "../../shared/stable-json.js";

export const SAVED_SOURCE_BATCH_LIMITS = Object.freeze({
  entries: 4,
  nativeBytes: 32 * 1024 * 1024,
  preparedBytes: 64 * 1024 * 1024,
});

/** Large originals are captured in bounded batches; no catalog-sized buffer is retained while parsing. */
export function* savedSourceBatches(entries: readonly SavedSourceMetadata[]) {
  let batch: SavedSourceMetadata[] = [],
    bytes = 0;
  for (const entry of entries) {
    const size = entry.binding.original?.size ?? 0;
    if (size > SAVED_SOURCE_BATCH_LIMITS.nativeBytes) throw new ProjectContentError("tooLarge");
    if (
      batch.length &&
      (batch.length >= SAVED_SOURCE_BATCH_LIMITS.entries || bytes + size > SAVED_SOURCE_BATCH_LIMITS.nativeBytes)
    ) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length) yield batch;
}

export function assertSavedSourceMetadata(
  expected: readonly SavedSourceMetadata[],
  current: readonly SavedSourceMetadata[],
) {
  if (stableJson(expected) !== stableJson(current)) throw new ProjectContentError("conflict");
}
