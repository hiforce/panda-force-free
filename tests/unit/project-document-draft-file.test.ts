import { expect, test } from "bun:test";
import { draftContent } from "../../src/server/project-content/drafts/content.js";
import {
  decodeDraftFile,
  encodeDraftFile,
  encodeDraftReceipt,
  type ProjectDraftFrame,
  type ProjectDraftFile,
} from "../../src/server/project-content/drafts/file.js";
import { contentRequestHash } from "../../src/server/project-content/mutation.js";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";

function record(): ProjectDraftFile {
  const frame: ProjectDraftFrame = {
    schema: 1,
    projectId: "project-1",
    documentId: "doc-1",
    spaceId: "space-1",
    version: 1,
    baseRevisionId: "revision-1",
    content: draftContent({
      title: "Working source",
      locale: "en",
      content: "EXACT-UNSAVED-SOURCE\r\n",
      body: emptyRichBody(),
    }),
    updatedAt: 100,
  };
  return {
    ...frame,
    lastOperation: {
      schema: 1,
      projectId: frame.projectId,
      documentId: frame.documentId,
      operationId: "autosave",
      requestHash: "a".repeat(64),
      actor: "owner",
      kind: "autosave",
      version: frame.version,
      baseRevisionId: frame.baseRevisionId,
      stateHash: contentRequestHash(frame),
      updatedAt: frame.updatedAt,
    },
  };
}

test("draft files preserve exact rich projections while receipt files contain metadata only", () => {
  const value = record();
  expect(decodeDraftFile(encodeDraftFile(value))).toEqual(value);
  expect(decodeDraftFile(encodeDraftFile(value)).content?.content).toBe("EXACT-UNSAVED-SOURCE\r\n");
  expect(encodeDraftReceipt(value.lastOperation)).not.toContain("EXACT-UNSAVED-SOURCE");
  expect(draftContent({ title: "Empty", locale: "en", content: "" }).resources).toEqual([]);
});

test("draft codecs reject changed frames, mismatched receipts, unrecognized fields and invalid source bodies", () => {
  const value = record();
  for (const changed of [
    { ...value, version: 2 },
    { ...value, documentId: "another-document" },
    { ...value, content: { ...value.content, title: "Manual edit" } },
    { ...value, apiKey: "example-only" },
    { ...value, lastOperation: { ...value.lastOperation, kind: "discard" } },
  ])
    expect(() => decodeDraftFile(JSON.stringify(changed))).toThrow("invalidFile");
  for (const content of [
    { title: "Bad", locale: "en", content: "", token: "example-only" },
    { title: "Bad", locale: "en", content: "", body: { schema: 1, format: "html", document: { type: "doc" } } },
    {
      title: "Bad",
      locale: "en",
      content: "",
      resources: [{ source: "image.png", sourcePath: "image.png", assetId: "../escape", digest: "a".repeat(64) }],
    },
  ])
    expect(() => draftContent(content)).toThrow("invalidFile");
});
