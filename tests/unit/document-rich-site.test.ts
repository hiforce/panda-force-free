import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { richDocumentInput } from "../../src/server/documents/rich-codec.js";
import { richSiteContent } from "../../src/shared/documents/rich-site.js";

test("rich site output preserves alignment, merged cells, lists, marks, links and image dimensions without interpreting user text", () => {
  const id = randomUUID(),
    literal = '<script>alert(1)</script> {% include "secret" %} {process.env.KEY} **literal**',
    { body } = richDocumentInput({
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2, textAlign: "center" },
            content: [
              {
                type: "text",
                text: literal,
                marks: [{ type: "underline" }, { type: "bold" }, { type: "italic" }, { type: "strike" }],
              },
            ],
          },
          {
            type: "paragraph",
            attrs: { textAlign: "right" },
            content: [
              {
                type: "text",
                text: "A link",
                marks: [{ type: "link", attrs: { href: 'https://example.test/{%raw%}?q="x"' } }],
              },
              { type: "hardBreak" },
              { type: "text", text: "Inline code", marks: [{ type: "code" }] },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "js" },
            content: [{ type: "text", text: 'const x = "<div>";\nconsole.log({x});' }],
          },
          {
            type: "orderedList",
            attrs: { start: 3, type: "a" },
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Third item" }] }] },
            ],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Checked item" }] }],
              },
            ],
          },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    attrs: { colspan: 2, colwidth: [120, 140], align: "center" },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: { rowspan: 2, colwidth: [120] },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Two rows" }] }],
                  },
                  { type: "tableCell", attrs: { colwidth: [140] }, content: [{ type: "paragraph" }] },
                ],
              },
              {
                type: "tableRow",
                content: [{ type: "tableCell", attrs: { colwidth: [140] }, content: [{ type: "paragraph" }] }],
              },
            ],
          },
          {
            type: "image",
            attrs: {
              src: "/api/document-assets/content?id=" + id,
              alt: 'An image "quoted"',
              title: "Original image",
              width: 48,
              height: 36,
            },
          },
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quote" }] }] },
          { type: "horizontalRule" },
        ],
      },
    }),
    images = new Map([[id, "/guide/assets/My%20image.png"]]),
    before = JSON.stringify(body);
  const html = richSiteContent(body, "hexo", images),
    document = new JSDOM(html).window.document;
  expect(document.querySelector("h2")!.textContent).toBe(literal);
  expect(document.querySelector("h2")!.style.textAlign).toBe("center");
  expect(document.querySelector("script")).toBeNull();
  expect(html).not.toContain("{%");
  expect(
    document.querySelector("u strong") || document.querySelector("strong u") || document.querySelector("u"),
  ).not.toBeNull();
  expect(document.querySelector("th")!.colSpan).toBe(2);
  expect(document.querySelector("th")!.getAttribute("width")).toBe("260");
  expect(document.querySelector("td")!.rowSpan).toBe(2);
  expect(document.querySelector("ol")!.start).toBe(3);
  expect(document.querySelector("input")!.checked).toBe(true);
  expect(document.querySelector("input")!.disabled).toBe(true);
  expect(document.querySelector("img")!.getAttribute("src")).toBe(images.get(id)!);
  expect(document.querySelector("img")!.width).toBe(48);
  expect(document.querySelector("pre")!.textContent).toContain("console.log({x});");
  const jsx = richSiteContent(body, "docusaurus", images);
  expect(jsx).toContain('textAlign:"center"');
  expect(jsx).toContain(' colSpan={"2"}');
  expect(jsx).toContain(' rowSpan={"2"}');
  expect(jsx).toContain("\\u003cscript>");
  expect(jsx).not.toContain('{"<');
  expect(jsx).not.toContain("/api/document-assets");
  expect(jsx).not.toContain("<script>");
  expect(JSON.stringify(body)).toBe(before);
});

test("rich site projection fails closed on missing image mappings and unsupported future node types", () => {
  const id = randomUUID(),
    { body } = richDocumentInput({
      schema: 1,
      format: "richtext",
      document: { type: "doc", content: [{ type: "image", attrs: { src: "/api/document-assets/content?id=" + id } }] },
    });
  expect(() => richSiteContent(body, "hexo", new Map())).toThrow("missingImage");
  expect(() =>
    richSiteContent(
      { ...body, document: { type: "doc", content: [{ type: "unknownWidget" }] } },
      "docusaurus",
      new Map(),
    ),
  ).toThrow("unsupportedNode");
});
