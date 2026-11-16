import { expect, test } from "bun:test";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { knowledgeDraft } from "../../src/shared/knowledge/validation.js";
import type { KnowledgeDraftInput, KnowledgeEvidenceSource } from "../../src/shared/knowledge/contracts.js";

const asset: KnowledgeEvidenceSource = {
  id: "document-1",
  version: "saved-1",
  kind: "asset",
  title: "Storage guide",
  text: "🚀 Start here. Use local storage. Repeat: Use local storage.",
  sections: [{ id: "intro", start: 0, end: "🚀 Start here. Use local storage.".length }],
};
const input = (): KnowledgeDraftInput => ({
  schema: 1,
  title: "Storage",
  summary: "Source-backed notes",
  claims: [
    {
      id: "claim-1",
      kind: "source",
      text: "The guide recommends local storage.",
      evidence: [{ sourceId: asset.id, version: asset.version, quote: "Use local storage.", section: "intro" }],
    },
  ],
  uncertainties: [],
});
test("knowledge references resolve exact saved text and Unicode offsets within the selected section", () => {
  const result = validateKnowledgeEvidence(input(), [asset]),
    proof = result.claims[0]!.evidence[0]!;
  expect(proof.start).toBe(asset.text.indexOf(proof.quote));
  expect(asset.text.slice(proof.start, proof.end)).toBe(proof.quote);
  expect(proof.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(() => validateKnowledgeEvidence(input(), [{ ...asset, version: "saved-2" }])).toThrow("sourceChanged");
  expect(() => validateKnowledgeEvidence(input(), [])).toThrow("invalidEvidence");
});
test("ambiguous, fabricated and out-of-section references cannot be admitted", () => {
  const draft = input(),
    evidence = draft.claims[0]!.evidence[0]!;
  delete evidence.section;
  expect(() => validateKnowledgeEvidence(draft, [asset])).toThrow("ambiguousEvidence");
  evidence.start = asset.text.lastIndexOf(evidence.quote);
  expect(validateKnowledgeEvidence(draft, [asset]).claims[0]!.evidence[0]!.start).toBe(evidence.start);
  evidence.section = "intro";
  expect(() => validateKnowledgeEvidence(draft, [asset])).toThrow("invalidEvidence");
  evidence.start = 0;
  evidence.quote = "An invented source quote";
  expect(() => validateKnowledgeEvidence(draft, [asset])).toThrow("invalidEvidence");
});
test("source facts, user input and model inference retain distinct provenance", () => {
  const draft = input();
  draft.claims[0]!.kind = "user";
  expect(() => validateKnowledgeEvidence(draft, [asset])).toThrow("invalidEvidence");
  expect(validateKnowledgeEvidence(draft, [{ ...asset, kind: "user-input" }]).claims[0]!.kind).toBe("user");
  draft.claims[0]!.kind = "source";
  expect(() => validateKnowledgeEvidence(draft, [{ ...asset, kind: "user-input" }])).toThrow("invalidEvidence");
  draft.claims[0]!.evidence = [];
  expect(() => validateKnowledgeEvidence(draft, [asset])).toThrow("invalidEvidence");
  draft.claims[0]!.kind = "inference";
  expect(validateKnowledgeEvidence(draft, [asset]).claims[0]!.evidence).toEqual([]);
});
test("knowledge drafts reject execution fields, duplicate identities and invalid ranges", () => {
  const draft = input();
  expect(() => knowledgeDraft({ ...draft, script: "run()" })).toThrow("invalidInput");
  draft.claims.push(structuredClone(draft.claims[0]!));
  expect(() => knowledgeDraft(draft)).toThrow("invalidInput");
  expect(() =>
    validateKnowledgeEvidence(input(), [{ ...asset, sections: [{ id: "bad", start: -1, end: 4 }] }]),
  ).toThrow("invalidEvidence");
  expect(() => validateKnowledgeEvidence(input(), [asset, asset])).toThrow("invalidEvidence");
});
