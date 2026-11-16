import { expect, test } from "bun:test";
import { defaultGenerationPolicy, generationChange } from "../../src/shared/knowledge/generation.js";
import { generationMatches } from "../../src/server/knowledge/generation/selection.js";

const snapshot = {
  commit: "saved",
  documents: [
    { id: "root", parentId: null, version: "1" },
    { id: "child", parentId: "root", version: "2" },
    { id: "leaf", parentId: "child", version: "3" },
    { id: "other", parentId: null, version: "4" },
  ],
};
test("generation selection distinguishes single documents and subtrees, with exclusions taking precedence", () => {
  const selection = defaultGenerationPolicy().selection,
    ids = (change: Partial<typeof selection>) =>
      generationMatches(snapshot, { ...selection, ...change }).map((row) => row.id);
  expect(ids({ documents: ["root"] })).toEqual(["root"]);
  expect(ids({ subtrees: ["root"] })).toEqual(["root", "child", "leaf"]);
  expect(ids({ all: true, excludeDocuments: ["child"] })).toEqual(["root", "other", "leaf"]);
  expect(ids({ all: true, documents: ["leaf"], excludeSubtrees: ["child"] })).toEqual(["root", "other"]);
  expect(() =>
    generationMatches({ commit: "bad", documents: [{ id: "loop", parentId: "loop", version: "x" }] }, selection),
  ).toThrow("conflict");
});
test("generation configuration rejects implicit enablement, unbounded budgets and injected authority", () => {
  const input = { ...defaultGenerationPolicy(), backfill: false };
  expect(generationChange(input).enabled).toBe(false);
  for (const change of [
    { enabled: true },
    { dailyLimit: 101 },
    { pendingLimit: 0 },
    { backfill: "true" },
    { owner: "another-user" },
    { automaticReview: true },
  ])
    expect(() => generationChange({ ...input, ...change })).toThrow("invalidInput");
});

test("native rule scopes are explicit, canonical and cannot widen legacy document subtrees", async () => {
  const { generationSelectedSnapshot, generationReadScope } =
      await import("../../src/server/knowledge/generation/sources.js"),
    legacy = { ...defaultGenerationPolicy(), backfill: false };
  expect(JSON.stringify(generationChange(legacy))).toBe(JSON.stringify(legacy));
  const policy = generationChange({
    ...legacy,
    enabled: true,
    purpose: "Native sources",
    selection: {
      ...legacy.selection,
      subtrees: ["root"],
      originals: { contentKinds: ["web", "slides"], all: true, ids: [], exclude: ["web-2"] },
    },
  });
  expect(policy.selection.originals!.contentKinds).toEqual(["slides", "web"]);
  const value = {
    ...snapshot,
    originals: [
      { id: "web-1", kind: "web" as const, version: "w1" },
      { id: "web-2", kind: "web" as const, version: "w2" },
      { id: "slide-1", kind: "slides" as const, version: "s1" },
    ],
  };
  expect(generationSelectedSnapshot(value, legacy.selection).originals).toBeUndefined();
  expect(generationSelectedSnapshot(value, policy.selection).originals!.map((row) => row.id)).toEqual([
    "web-1",
    "slide-1",
  ]);
  expect(generationSelectedSnapshot(value, policy.selection).documents.map((row) => row.id)).toEqual([
    "root",
    "child",
    "leaf",
  ]);
  expect(generationReadScope(legacy.selection)).toBeUndefined();
  for (const originals of [
    { contentKinds: ["document"], all: true, ids: [], exclude: [] },
    { contentKinds: ["web", "web"], all: true, ids: [], exclude: [] },
    { contentKinds: ["web"], all: "true", ids: [], exclude: [] },
    { contentKinds: ["web"], all: true, ids: [], exclude: [], owner: "other" },
  ])
    expect(() => generationChange({ ...legacy, selection: { ...legacy.selection, originals } })).toThrow(
      "invalidInput",
    );
  expect(() =>
    generationSelectedSnapshot({ ...value, originals: [{ id: "root", kind: "web", version: "w" }] }, policy.selection),
  ).toThrow("conflict");
});
