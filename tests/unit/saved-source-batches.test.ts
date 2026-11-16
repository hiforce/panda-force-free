import { expect, test } from "bun:test";
import type { SavedSourceMetadata } from "../../src/shared/content-sources/contracts.js";
import { savedSourceBatches, SAVED_SOURCE_BATCH_LIMITS } from "../../src/server/content-sources/batches.js";

function source(id: string, size: number): SavedSourceMetadata {
  return {
    id,
    version: "version",
    title: id,
    locale: "en",
    path: "deck.pptx",
    updatedAt: 1,
    ancestors: [],
    binding: {
      kind: "slides",
      path: "creations/" + id,
      blob: "blob",
      original: { name: "deck.pptx", digest: "digest", size },
      resources: [],
    },
  };
}
test("source capture batches bound both original bytes and entry count", () => {
  expect(
    [...savedSourceBatches(Array.from({ length: 5 }, (_, n) => source(String(n), 10)))].map((b) => b.length),
  ).toEqual([4, 1]);
  const batches = [...savedSourceBatches([source("a", 20 * 1024 * 1024), source("b", 20 * 1024 * 1024)])];
  expect(batches.map((b) => b.length)).toEqual([1, 1]);
  expect(() => [...savedSourceBatches([source("large", SAVED_SOURCE_BATCH_LIMITS.nativeBytes + 1)])]).toThrow();
});
