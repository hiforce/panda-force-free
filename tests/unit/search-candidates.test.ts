import { expect, test } from "bun:test";
import { fuseSearchCandidates } from "../../src/server/search/candidates.js";
test("hybrid ranking keeps document and knowledge identities distinct and ignores duplicate provider rows", () => {
  const value = { id: "same-id", version: "saved", title: "", snippet: "", score: 999 },
    merged = fuseSearchCandidates([
      [
        { ...value, kind: "document" },
        { ...value, kind: "document" },
      ],
      [{ ...value, version: "approved", kind: "knowledge" }],
    ]);
  expect(merged).toHaveLength(2);
  expect(merged.map((hit) => hit.kind).sort()).toEqual(["document", "knowledge"]);
  expect(merged[0]!.score).toBe(merged[1]!.score);
});
