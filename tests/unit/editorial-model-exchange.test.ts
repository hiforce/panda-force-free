import { expect, test } from "bun:test";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import { applyRichTextEdits } from "../../src/shared/editorial/rich-edits.js";
import {
  editorialModelInput,
  reviewedModelOutput,
  MODEL_EDITORIAL_LIMITS,
} from "../../src/server/editorial/model/exchange.js";
import type { EditorialSource } from "../../src/server/editorial/ports.js";

const profile = { id: "review", engine: "isolated-test", model: "test-model", version: "1" };
const source = (body: RichDocumentBody): EditorialSource => ({
  ref: { documentId: "doc", revisionId: "revision", sourceHash: "hash", version: 1 },
  body,
});
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const body = (text = "This are a test."): RichDocumentBody => ({
  schema: 1,
  format: "richtext",
  document: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "right" },
        content: [
          { type: "text", text, marks: [{ type: "bold" }] },
          { type: "text", text: "protected link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
          { type: "text", text: "inline code", marks: [{ type: "code" }] },
        ],
      },
      { type: "blockquote", content: [paragraph("A quotation must stay unchanged.")] },
      { type: "codeBlock", content: [{ type: "text", text: "secret_code();" }] },
      {
        type: "image",
        attrs: { src: "/api/document-assets/content?id=00000000-0000-0000-0000-000000000000", alt: "asset" },
      },
    ],
  },
});

test("model exchange only exposes bounded editable segments; accepted changes retain marks, images and protected scopes", () => {
  const original = source(body()),
    input = editorialModelInput(original, "proofread");
  expect(input.segments).toHaveLength(1);
  expect(JSON.stringify(input)).not.toContain("secret_code");
  expect(JSON.stringify(input)).not.toContain("https://");
  expect(JSON.stringify(input)).not.toContain("document-assets");
  expect(JSON.stringify(input)).not.toContain("quotation");
  const output = reviewedModelOutput(
    original,
    input,
    profile,
    JSON.stringify({
      edits: [
        {
          segmentId: input.segments[0]!.id,
          before: "This are a test.",
          after: "This is a test.",
          reason: "Subject agreement",
        },
      ],
    }),
  );
  expect(output.producer).toEqual({ kind: "model", engine: "isolated-test", model: "test-model", version: "1" });
  const result = applyRichTextEdits(original.body, output.edits);
  expect(result.document.content![0]!.content![0]!.text).toBe("This is a test.");
  expect(result.document.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }]);
  expect(result.document.content![0]!.attrs).toEqual({ textAlign: "right" });
  expect(result.document.content!.slice(1).map((node) => node.type)).toEqual(["blockquote", "codeBlock", "image"]);
  expect(original.body.document.content![0]!.content![0]!.text).toBe("This are a test.");
  expect(editorialModelInput(original, "proofread")).toEqual(input);
  expect(
    editorialModelInput({ ...original, ref: { ...original.ref, version: 2 } }, "proofread").segments[0]!.id,
  ).not.toBe(input.segments[0]!.id);
});

test("model results cannot invent locations, replace unknown text, duplicate segments or add executable fields", () => {
  const original = source(body()),
    input = editorialModelInput(original, "rewrite"),
    edit = { segmentId: input.segments[0]!.id, before: input.segments[0]!.text, after: "A test.", reason: "Shorten" };
  for (const output of [
    null,
    {},
    "```json\n{}\n```",
    JSON.stringify({}),
    JSON.stringify({ edits: [], command: "publish" }),
    JSON.stringify({ edits: [{ ...edit, path: [1, 0, 0] }] }),
    JSON.stringify({ edits: [{ ...edit, segmentId: "invented" }] }),
    JSON.stringify({ edits: [{ ...edit, before: "unknown" }] }),
    JSON.stringify({ edits: [edit, edit] }),
    JSON.stringify({ edits: [{ ...edit, after: edit.before }] }),
    JSON.stringify({ edits: [{ ...edit, after: "bad\0text" }] }),
    JSON.stringify({ edits: [{ ...edit, reason: "x".repeat(2001) }] }),
    "x".repeat(MODEL_EDITORIAL_LIMITS.outputBytes + 1),
  ])
    expect(() => reviewedModelOutput(original, input, profile, output)).toThrow("invalidOutput");
  expect(reviewedModelOutput(original, input, profile, '{"edits":[]}').edits).toEqual([]);
});

test("large Unicode sources split at grapheme boundaries and report partial review instead of dropping the source silently", () => {
  const original = source(body("👩🏽‍💻é".repeat(16000))),
    input = editorialModelInput(original, "rewrite");
  expect(input.truncated).toBe(true);
  expect(input.segments.length).toBeGreaterThan(1);
  expect(input.segments.length).toBeLessThanOrEqual(MODEL_EDITORIAL_LIMITS.segments);
  expect(input.segments.reduce((total, segment) => total + Buffer.byteLength(segment.text), 0)).toBeLessThanOrEqual(
    MODEL_EDITORIAL_LIMITS.inputBytes,
  );
  for (const segment of input.segments) {
    expect(Buffer.byteLength(segment.text)).toBeLessThanOrEqual(MODEL_EDITORIAL_LIMITS.segmentBytes);
    expect(segment.text).toMatch(/^(?:👩🏽‍💻|é)+$/u);
  }
  const result = reviewedModelOutput(
    original,
    input,
    profile,
    JSON.stringify({
      edits: input.segments.slice(0, 2).map((segment) => ({
        segmentId: segment.id,
        before: segment.text,
        after: "Reviewed.",
        reason: "Simplify",
      })),
    }),
  );
  expect(result.truncated).toBe(true);
  expect(result.edits[1]!.start).toBe(input.segments[1]!.start);
  expect(applyRichTextEdits(original.body, result.edits).document.content![0]!.content![0]!.text).toStartWith(
    "Reviewed.Reviewed.",
  );
});
