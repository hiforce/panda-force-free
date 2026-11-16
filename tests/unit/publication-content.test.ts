import { test, expect } from "bun:test";
import { parseContent } from "../../src/server/publishing/content/parse.js";
import { inlineText } from "../../src/server/publishing/content/inline.js";
const input = { documentId: "doc", revisionId: "revision", title: "Title", locale: "en", engine: "hexo" as const };
test("semantic Hexo tags remain traceable, unknown helpers are retained, and code stays literal", () => {
  const content =
    '---\ntitle: Test\n---\n\n{% abstract "Summary" %}\nBody &amp; detail.\n{% endabstract %}\n\n{% part "Part I" %}\n\n```js\n{% secret %}\n```\n\n{% unknown "keep" %}\nText\n{% endunknown %}\n';
  const ir = parseContent({ ...input, content });
  expect(ir.blocks.map((b) => b.kind)).toEqual(["container", "heading", "code", "opaque"]);
  expect(ir.blocks[3]!.raw).toContain('unknown "keep"');
  const container = ir.blocks[0]!;
  if (container.kind !== "container" || container.children[0]?.kind !== "paragraph")
    throw Error("Missing semantic body");
  expect(inlineText(container.children[0].inline)).toBe("Body & detail.");
  for (const block of ir.blocks)
    if (block.span.exact) expect(ir.source.slice(block.span.start, block.span.end)).toBe(block.raw);
  expect(ir.issues.map((i) => i.code)).toEqual(["opaqueSyntax"]);
});

import { renderContent } from "../../src/server/publishing/content/render.js";
import { proofread, applySuggestions } from "../../src/server/publishing/content/proofread.js";
test("HTML export retains literal unsupported syntax and escapes executable content", () => {
  const ir = parseContent({
    ...input,
    content:
      "Text with **bold** and [reference](https://example.com).\n\n<script>danger()</script>\n\n[bad](javascript:alert(1))\n\n```html\n<script>literal</script>\n```",
  });
  const rendered = renderContent(ir, "technical");
  expect(rendered.html).not.toContain("<script>");
  expect(rendered.html).not.toContain('href="javascript:');
  expect(rendered.text).toContain("https://example.com");
  expect(rendered.text).toContain("<script>literal</script>");
  expect(ir.issues.some((i) => i.code === "unsafeLink")).toBe(true);
});
test("proofreading proposals protect quotations, code and intentional Markdown breaks", () => {
  const content =
    "Words  with spaces.\n\n> Quote  unchanged.\n\n```js\nconst  x = 1;\n```\n\nLine break  \nnext line.\n";
  const ir = parseContent({ ...input, content });
  const suggestions = proofread(ir);
  expect(suggestions).toHaveLength(1);
  const result = applySuggestions(
    ir,
    suggestions.map((s) => s.id),
  );
  expect(result).toContain("Words with spaces.");
  expect(result).toContain("Quote  unchanged");
  expect(result).toContain("const  x");
  expect(result).toContain("break  \n");
  expect(() => applySuggestions(ir, ["forged"])).toThrow();
});

import { countPost, composePosts } from "../../src/server/publishing/adapters/x/posts.js";
test("X counting follows the official parser for URLs, CJK, emoji and normalized accents", () => {
  expect(countPost("A https://example.com/" + "long".repeat(80)).weightedLength).toBe(25);
  expect(countPost("中文").weightedLength).toBe(4);
  expect(countPost("👨‍👩‍👧‍👦").weightedLength).toBe(2);
  expect(countPost("cafe\u0301").weightedLength).toBe(4);
});
test("threads preserve paragraph order, never split URLs, and count their own numbering", () => {
  const link = "https://example.com/" + "long-path-".repeat(50);
  const ir = parseContent({
    ...input,
    content: "A clear sentence with 中文 and 👨‍👩‍👧‍👦. ".repeat(70) + "\n\nReference: " + link,
  });
  const posts = composePosts(ir, true);
  expect(posts.length).toBeGreaterThan(2);
  expect(posts.every((post) => post.valid && post.weightedLength <= 280)).toBe(true);
  expect(posts.some((post) => post.text.includes(link))).toBe(true);
  expect(
    posts
      .map((post) => post.text.replace(/^\d+\/\d+\n\n/, ""))
      .join(" ")
      .replace(/\s+/g, " "),
  ).toBe(
    [ir.title, ...ir.blocks.map((b) => (b.kind === "paragraph" ? inlineText(b.inline) : b.raw))]
      .join(" ")
      .replace(/\s+/g, " "),
  );
});

import { xArticleDraft } from "../../src/server/publishing/adapters/x/article-content.js";
test("repeated list text maps to the correct occurrence and empty-caption figures retain their image", () => {
  const ir = parseContent({
    ...input,
    content: '- Repeated text.\n- Repeated text.\n\n{% figure "picture.png" "Caption" %}\n{% endfigure %}',
  });
  const list = ir.blocks[0]!;
  if (list.kind !== "list") throw Error("Missing list");
  const first = list.items[0]!.children[0]!,
    second = list.items[1]!.children[0]!;
  expect(first.span.exact).toBe(true);
  expect(second.span.exact).toBe(true);
  expect(second.span.start).toBeGreaterThan(first.span.end);
  const figure = ir.blocks[1]!;
  if (figure.kind !== "container") throw Error("Missing figure");
  expect(figure.image?.source).toBe("picture.png");
  expect(figure.image?.alt).toBe("Caption");
});
test("X Article uses the documented schema with UTF-16 styles, code entities and explicit unresolved media", () => {
  const ir = parseContent({
    ...input,
    content:
      "## Heading\n\n👋 **Bold** [link](https://example.com)\n\n```js\nconst x = 1;\n```\n\n![Cover](/api/document-assets/content?id=11111111-1111-1111-1111-111111111111)\n",
  });
  const draft = xArticleDraft(ir);
  expect(draft.payload.content_state.blocks[0]!.type).toBe("header-two");
  const paragraph = draft.payload.content_state.blocks[1]!;
  expect(paragraph.inline_style_ranges).toEqual([{ style: "bold", offset: 3, length: 4 }]);
  expect(draft.payload.content_state.entities.some((entity) => entity.value.type === "markdown")).toBe(true);
  expect(draft.issues.some((issue) => issue.code === "imageNeedsUpload" && issue.severity === "warning")).toBe(true);
  const ready = xArticleDraft(
    ir,
    new Map([
      [
        "/api/document-assets/content?id=11111111-1111-1111-1111-111111111111",
        { media_id: "12345", media_category: "tweet_image" },
      ],
    ]),
  );
  expect(ready.issues.some((issue) => issue.code === "imageNeedsUpload")).toBe(false);
  expect(ready.payload.content_state.entities.at(-1)?.value.data.media_items?.[0]?.media_id).toBe("12345");
});

test("X Article keeps images inside quotes, lists and tables explicit instead of losing them during flattening", () => {
  const source = "/api/document-assets/content?id=11111111-1111-1111-1111-111111111111";
  const ir = parseContent({
    ...input,
    content: `> **Quote** ![Quote image](${source})\n\n3. ![List image](${source})\n4. Next\n\n| Image |\n| --- |\n| ![Table image](${source}) |`,
  });
  const pending = xArticleDraft(ir);
  expect(pending.issues.filter((issue) => issue.code === "imageNeedsUpload")).toHaveLength(3);
  const ready = xArticleDraft(ir, new Map([[source, { media_id: "123", media_category: "tweet_image" }]]));
  expect(ready.payload.content_state.entities.filter((entity) => entity.value.type === "image")).toHaveLength(3);
  expect(JSON.stringify(ready.payload)).not.toContain("/api/document-assets");
  expect(ready.payload.content_state.blocks.some((block) => block.text.startsWith("4. Next"))).toBe(true);
  expect(ready.payload.content_state.blocks[0]!.inline_style_ranges?.[0]?.style).toBe("bold");
});
