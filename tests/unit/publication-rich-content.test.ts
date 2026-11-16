import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import type { RichDocumentBody, RichTextNode } from "../../src/shared/documents/rich-body.js";
import { richDocumentInput } from "../../src/server/documents/rich-codec.js";
import { contentHash } from "../../src/server/documents/content-hash.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { parseContent, type ContentSource } from "../../src/server/publishing/content/parse.js";
import { renderContent } from "../../src/server/publishing/content/render.js";
import { contentImages } from "../../src/server/publishing/content/walk.js";
import { proofread, applySuggestions } from "../../src/server/publishing/content/proofread.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { xArticleDraft } from "../../src/server/publishing/adapters/x/article-content.js";
import { documentPublicationSources } from "../../src/server/publishing/integration/document-source.js";
import { createPublishingFeature } from "../../src/server/publishing/integration/feature.js";

const asset = "/api/document-assets/content?id=11111111-1111-1111-1111-111111111111";
const text = (value: string): RichTextNode => ({ type: "text", text: value });
const paragraph = (value: string): RichTextNode => ({ type: "paragraph", content: [text(value)] });
function richBody(image = asset): RichDocumentBody {
  return {
    schema: 1,
    format: "richtext",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "center" },
          content: [
            text("👋 "),
            { ...text("Bold"), marks: [{ type: "bold" }] },
            text(" "),
            { ...text("Underline"), marks: [{ type: "underline" }] },
            text(" "),
            { ...text("Link"), marks: [{ type: "link", attrs: { href: "https://example.com/guide" } }] },
          ],
        },
        paragraph("<script>literal & safe</script>"),
        { type: "image", attrs: { src: image, alt: "Original cover", title: "Cover title", width: 640, height: 360 } },
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [text("const text = '```';\n<script>literal</script>")],
        },
        {
          type: "orderedList",
          attrs: { start: 3, type: "A" },
          content: [{ type: "listItem", content: [paragraph("List content")] }],
        },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("Task done")] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2, colwidth: [100, 120], align: "center" },
                  content: [
                    paragraph("Merged heading"),
                    { type: "image", attrs: { src: image, alt: "Table picture" } },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", attrs: { colwidth: [100] }, content: [paragraph("Cell A")] },
                { type: "tableCell", attrs: { colwidth: [120] }, content: [paragraph("Cell B")] },
              ],
            },
          ],
        },
      ],
    },
  };
}
function source(body = richBody()): ContentSource {
  return {
    documentId: "document",
    revisionId: "revision",
    title: "Rich article",
    locale: "en",
    engine: "markdown",
    content: "Exchange view only.\n",
    body: richDocumentInput(body).body,
  };
}

test("channel parsing preserves canonical rich semantics and identity instead of reparsing exchange Markdown", () => {
  const input = source(),
    ir = parseContent(input),
    output = renderContent(ir, "technical");
  expect(ir.sourceHash).toBe(contentHash(input.content, input.body));
  expect(output.text).toContain("👋 Bold Underline Link (https://example.com/guide)");
  expect(output.text).not.toContain("Exchange view only");
  expect(output.html).toContain("<u>Underline</u>");
  expect(output.html).toContain("text-align:center");
  expect(output.html).toContain('colspan="2" rowspan="1" width="220"');
  expect(output.html).toContain('width="640" height="360"');
  expect(output.html).toContain('<ol start="3" type="A"');
  expect(output.html).toContain("☑ ");
  expect(output.html).toContain("&lt;script&gt;literal &amp; safe&lt;/script&gt;");
  expect(output.html).not.toContain("<script>");
  expect(ir.blocks.every((block) => !block.span.exact && block.richPath?.length)).toBe(true);
  expect(ir.origin?.body).toEqual(input.body);
  expect(ir.blocks[6]?.kind).toBe("grid");
  const changed = structuredClone(input.body!);
  changed.document.content![0]!.attrs = { textAlign: "right" };
  expect(parseContent({ ...input, body: changed }).sourceHash).not.toBe(ir.sourceHash);
  expect(parseContent({ ...input, content: "A different exchange serialization." }).sourceHash).toBe(ir.sourceHash);
  const code = ir.blocks[3]!;
  expect(code.raw).toStartWith("````js\n");
  expect(code.raw).toEndWith("\n````");
});

test("format losses are explicit per channel, and nested media occurs once in Post and Article payloads", () => {
  const ir = parseContent(source()),
    formats = builtinFormats();
  const html = formats.get("html")!.format(ir, "technical");
  expect(html.issues).toEqual([]);
  const plain = formats.get("plain")!.format(ir, "technical");
  expect(plain.issues.some((issue) => issue.code === "unsupportedStyle" && issue.blockId === ir.blocks[0]!.id)).toBe(
    true,
  );
  expect(plain.issues.some((issue) => issue.code === "structuredTextFlattened")).toBe(true);
  expect(contentImages(ir).map((image) => image.alt)).toEqual(["Original cover", "Table picture"]);
  const thread = formats.get("x-thread")!.format(ir, "technical");
  expect(thread.posts.flatMap((post) => post.imageIndexes)).toEqual([0, 1]);
  const article = xArticleDraft(ir, new Map([[asset, { media_id: "media", media_category: "tweet_image" }]]));
  const first = article.payload.content_state.blocks[0]!;
  expect(first.text).toBe("👋 Bold Underline Link");
  expect(first.inline_style_ranges).toEqual([{ style: "bold", offset: 3, length: 4 }]);
  expect(first.entity_ranges?.map((range) => ({ offset: range.offset, length: range.length }))).toEqual([
    { offset: 18, length: 4 },
  ]);
  expect(article.payload.content_state.entities.filter((entity) => entity.value.type === "image")).toHaveLength(2);
  expect(JSON.stringify(article.payload)).not.toContain("/api/document-assets");
  expect(article.issues.some((issue) => issue.code === "imageNeedsUpload")).toBe(false);
  expect(article.issues.some((issue) => issue.code === "unsupportedStyle" && issue.blockId === ir.blocks[0]!.id)).toBe(
    true,
  );
  expect(
    article.issues.some((issue) => issue.code === "structuredTextFlattened" && issue.blockId === ir.blocks[6]!.id),
  ).toBe(true);
  const markdown = article.payload.content_state.entities
    .filter((entity) => entity.value.type === "markdown")
    .map((entity) => entity.value.data.markdown)
    .join("\n");
  expect(markdown).toContain("Merged heading");
  expect(markdown).toContain("Cell A | Cell B");
  expect(markdown).not.toContain('"type":"table"');
});

test("Markdown range proposals can never overwrite a rich original, including an empty selection", () => {
  const ir = parseContent({ ...source(), content: "Words  with spaces.\n" });
  expect(proofread(ir)).toEqual([]);
  expect(() => applySuggestions(ir, [])).toThrow("structured edit proposals");
});

test("rich structural blocks keep readable text and reject unsupported or unsafe source data", () => {
  const body: RichDocumentBody = {
    schema: 1,
    format: "richtext",
    document: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 4, textAlign: "right" }, content: [text("Heading")] },
        { type: "paragraph", content: [text("First"), { type: "hardBreak" }, text("Second")] },
        {
          type: "blockquote",
          content: [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph("Nested quote")] }] }],
        },
        { type: "horizontalRule" },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [paragraph("Header")] }] },
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [paragraph("<script>table</script> | a_b")] }],
            },
          ],
        },
      ],
    },
  };
  const input = source(body),
    ir = parseContent(input),
    article = xArticleDraft(ir);
  const output = renderContent(ir, "technical");
  expect(output.text).toContain("First\nSecond");
  expect(output.text).toContain("> • Nested quote");
  expect(output.html).toContain("<h4");
  expect(output.html).toContain("<hr");
  expect(output.html).not.toContain("<script>");
  const table = article.payload.content_state.entities.find((entity) => entity.value.type === "markdown")?.value.data
    .markdown;
  expect(table).toContain("| Header |\n| --- |");
  expect(table).toContain("\\<script\\>table\\</script\\> \\| a\\_b");
  const unsupported = structuredClone(input.body!);
  unsupported.document.content!.push({ type: "html", text: "<script>execute()</script>" });
  expect(() => parseContent({ ...input, body: unsupported })).toThrow("unsupportedNode");
  const unsafe = structuredClone(input.body!);
  unsafe.document.content![0]!.content![0]!.marks = [{ type: "link", attrs: { href: "javascript:execute()" } }];
  expect(() => parseContent({ ...input, body: unsafe })).toThrow("invalidLink");
  const remote = richBody("https://example.com/private.png");
  expect(() => parseContent({ ...input, body: remote })).toThrow();
});

test("a real project original produces frozen rich variants, owned image exports and reviewable losses across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-rich-publication-"));
  const documents = createDocumentFeature({
    stateRoot: root,
    allowedRoots: [root],
    requireProject: (id) => {
      if (id !== "project") throw Error("Forbidden project");
    },
  });
  let db = new Database(join(root, "variants.sqlite"));
  try {
    const original = documents.library.create("project", { title: "Original", locale: "en" });
    const image = await documents.assets.upload(
      original.document.id,
      "Original cover.png",
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
    const saved = documents.service.saveDocument(original.document.id, {
      revision: 1,
      title: "Rich article",
      locale: "en",
      body: richBody(`/api/document-assets/content?id=${image.id}`),
    });
    const bridge = documentPublicationSources(documents.service, documents.assets);
    let publishing = createPublishingFeature(db, bridge.sources, bridge.assets);
    const prepare = (format: string) =>
      publishing.variants.prepare({
        documentId: saved.document.id,
        revisionId: saved.revision.id,
        mode: "format",
        format,
        templateId: "technical",
      });
    const html = await prepare("html"),
      article = await prepare("x-article");
    expect(html.variant.source.sourceHash).toBe(saved.revision.contentHash);
    await expect(
      publishing.variants.review(article.variant.id, { digest: article.digest, acceptedIssues: [] }, "reviewer"),
    ).rejects.toThrow("reviewRequired");
    await publishing.variants.review(
      article.variant.id,
      {
        digest: article.digest,
        acceptedIssues: article.variant.issues
          .filter((issue) => issue.severity === "warning")
          .map((issue) => `${issue.blockId}:${issue.code}`),
      },
      "reviewer",
    );
    expect(() => publishing.variants.proofreadProposal(saved.document.id, saved.revision.id, [])).toThrow(
      "unsupportedMode",
    );
    const foreign = documents.library.create("project", { title: "Foreign", locale: "en" });
    await expect(bridge.assets.content(foreign.document.id, image.id)).rejects.toThrow("assetUnavailable");
    documents.service.saveDocument(saved.document.id, {
      revision: 2,
      title: "Next source",
      locale: "en",
      body: { schema: 1, format: "richtext", document: { type: "doc", content: [paragraph("Next contents")] } },
    });
    db.close();
    db = new Database(join(root, "variants.sqlite"));
    publishing = createPublishingFeature(db, bridge.sources, bridge.assets);
    const frozen = await publishing.variants.detail(article.variant.id);
    expect(frozen.stale).toBe(true);
    expect(frozen.review?.digest).toBe(article.digest);
    const files = unzipSync((await publishing.exporter.export(article.variant.id, "bundle")).bytes);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest.sourceFormat).toBe("richtext");
    expect(manifest.canonicalSource).toBe("source.rich.json");
    expect(JSON.parse(strFromU8(files[manifest.canonicalSource]!))).toEqual(saved.revision.body);
    expect(contentHash(strFromU8(files["source.md"]!), JSON.parse(strFromU8(files["source.rich.json"]!)))).toBe(
      saved.revision.contentHash,
    );
    expect(strFromU8(files["article.html"]!)).toContain("<u>Underline</u>");
    expect(strFromU8(files["article.html"]!)).not.toContain("Next contents");
    expect(Object.keys(files).filter((path) => path.startsWith("assets/"))).toEqual([
      `assets/${image.id}/Original cover.png`,
    ]);
    expect(manifest.assets[0].name).toBe("Original cover.png");
    expect(manifest.issues).toEqual(article.variant.issues);
    const payload = JSON.parse(strFromU8(files["x-article-draft.json"]!));
    expect(payload.readyToPublish).toBe(false);
  } finally {
    db.close();
    documents.close();
    await rm(root, { recursive: true, force: true });
  }
});
