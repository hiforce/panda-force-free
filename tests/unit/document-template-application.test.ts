import { expect, test } from "bun:test";
import { createPortableTemplateTypes, templateDocumentCodec } from "../../src/server/templates/integration/types.js";
import { DocumentTemplateAuthoring } from "../../src/server/templates/authoring/document.js";
import { applyRichDocumentTemplate } from "../../src/server/templates/application/rich-document.js";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import type { RichTextNode } from "../../src/shared/documents/rich-body.js";
import type { DocumentTemplateDefinition } from "../../src/shared/templates/authoring/contracts.js";
import { richMarkup } from "../../src/shared/documents/rich-markup.js";
import { documentTemplateRequest } from "../../src/shared/templates/application.js";

async function apply(nodes: RichTextNode[], values: unknown, edit?: (definition: DocumentTemplateDefinition) => void) {
  const definition = emptyDocumentTemplate("example.application");
  definition.parameters = [{ id: "title", label: { en: "Title" }, required: true, type: "text" }];
  definition.contentSlots = [{ id: "body", kind: "rich-text", default: "Default content" }];
  definition.body.document.content = nodes;
  edit?.(definition);
  const types = createPortableTemplateTypes(),
    template = await new DocumentTemplateAuthoring(types, templateDocumentCodec).create(definition),
    model = types.prepare(template).model;
  if (model.kind !== "document" || model.syntax !== "richtext") throw Error("Expected native rich template");
  return applyRichDocumentTemplate(model, template.manifest, values, templateDocumentCodec);
}

test("rich template application keeps split-mark placeholders, literal values, styled inline content and real list/table blocks", async () => {
  const body = await apply(
    [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          { type: "text", text: "Report: {{ti", marks: [{ type: "bold" }] },
          { type: "text", text: "tle}} / end", marks: [{ type: "italic" }] },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "{{body}}" }] },
    ],
    {
      title: "<script> {{body}}",
      body: "- First **bold**\n- Second\n\n| Left | Right |\n| --- | --- |\n| One | Two |",
    },
  );
  expect(body.document.content![0]!.content!.map((node) => node.text).join("")).toBe("Report: <script> {{body}} / end");
  expect(body.document.content![0]!.content!.find((node) => node.text?.includes("<script>"))!.marks).toEqual([
    { type: "bold" },
  ]);
  expect(body.document.content!.map((node) => node.type)).toEqual(["heading", "bulletList", "table"]);
  expect(JSON.stringify(body)).toContain('"bold"');
  const inline = await apply([{ type: "paragraph", content: [{ type: "text", text: "Before {{body}} after" }] }], {
    title: "Unused",
    body: "**strong** and [link](https://example.test)",
  });
  expect(JSON.stringify(inline)).toContain('"link"');
  expect(JSON.stringify(inline)).toContain('"bold"');
});

test("template application preserves literal code newlines and rejects invalid fields or block content in inline positions", async () => {
  const code = await apply(
    [{ type: "codeBlock", attrs: { language: "text" }, content: [{ type: "text", text: "{{title}}" }] }],
    { title: "one\ntwo", body: "unused" },
  );
  expect(code.document.content![0]!.content).toEqual([{ type: "text", text: "one\ntwo" }]);
  const nodes: RichTextNode[] = [{ type: "paragraph", content: [{ type: "text", text: "Prefix {{body}}" }] }];
  await expect(apply(nodes, { title: "Valid", body: "- A\n- B" })).rejects.toThrow("invalidParameters");
  await expect(apply(nodes, { body: "Text" })).rejects.toThrow("invalidParameters");
  await expect(apply(nodes, { title: "Valid", extra: "unknown" })).rejects.toThrow("invalidParameters");
});

test("repeated rich and plain substitutions cannot exceed document text or node capacity", async () => {
  await expect(
    apply([{ type: "paragraph", content: [{ type: "text", text: "{{title}}".repeat(160) }] }], {
      title: "x".repeat(16000),
    }),
  ).rejects.toThrow("invalidParameters");
  await expect(
    apply(
      Array.from({ length: 5000 }, () => ({ type: "paragraph", content: [{ type: "text", text: "{{body}}" }] })),
      { title: "valid", body: "- a\n- b\n- c" },
    ),
  ).rejects.toThrow("invalidParameters");
});

test("native link titles survive Markdown import and safe HTML projection without allowing unknown rich attributes", () => {
  const body = templateDocumentCodec.fromMarkdown('[Reference](https://example.test "A source title")'),
    mark = body.document.content![0]!.content![0]!.marks![0]!;
  expect(mark.attrs!.title).toBe("A source title");
  expect(richMarkup(body, "html", new Map())).toContain('title="A source title"');
  mark.attrs!.title = '" onclick="example';
  expect(richMarkup(templateDocumentCodec.normalize(body), "html", new Map())).toContain(
    "&quot; onclick=&quot;example",
  );
  mark.attrs!.unexpected = "rejected";
  expect(() => templateDocumentCodec.normalize(body)).toThrow("invalidPayload");
});

test("creation intent captures pinned template and values before asynchronous work and rejects executable or nested values", () => {
  const input = {
      template: { id: "example.article", version: "1.0.0", digest: "a".repeat(64) },
      values: { topic: "Original" },
    },
    accepted = documentTemplateRequest(input);
  input.values.topic = "Changed";
  input.template.version = "2.0.0";
  expect(accepted.values.topic).toBe("Original");
  expect(accepted.template.version).toBe("1.0.0");
  let invoked = false;
  expect(() =>
    documentTemplateRequest({
      ...input,
      values: {
        get topic() {
          invoked = true;
          return "unexpected";
        },
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
  expect(() => documentTemplateRequest({ ...input, values: { topic: { nested: true } } })).toThrow("invalidParameters");
});
