import twitterText from "twitter-text";
const { parseTweet } = twitterText;
import type { ContentBlock, ContentIR, ContentIssue, Inline } from "../../../../shared/publishing/content.js";
import { plainBlock } from "../../content/render.js";
import { inlineText, safeLink, unsupportedLink } from "../../content/inline.js";
import { contentImages } from "../../content/walk.js";
import { richFormatLosses } from "../../content/losses.js";
import { gridMarkdown } from "../../content/grid-markdown.js";

import type {
  XArticleDraft,
  XArticleBlock,
  XArticleEntity,
  XUploadedImage,
} from "../../../../shared/publishing/x-article.js";
export type {
  XArticleDraft,
  XArticleBlock,
  XArticleEntity,
  XUploadedImage,
} from "../../../../shared/publishing/x-article.js";

/** Serialize only documented article fields. Media is supplied after the authorized upload step. */
export function xArticleDraft(
  ir: ContentIR,
  media: ReadonlyMap<string, XUploadedImage> = new Map(),
): { payload: XArticleDraft; issues: ContentIssue[] } {
  const blocks: XArticleBlock[] = [],
    entities: XArticleEntity[] = [],
    issues = [...ir.issues, ...richFormatLosses(ir, "x-article")];
  let markdownWeight = 0;
  const issue = (id: string, code: ContentIssue["code"], severity: ContentIssue["severity"] = "warning") => {
    if (!issues.some((item) => item.blockId === id && item.code === code)) issues.push({ blockId: id, code, severity });
  };
  function entity(value: XArticleEntity["value"]): number {
    const key = entities.length;
    entities.push({ key: String(key), value });
    return key;
  }
  function atomic(id: string, value: XArticleEntity["value"]) {
    blocks.push({
      key: `${id}:${blocks.length}`,
      type: "atomic",
      text: " ",
      entity_ranges: [{ key: entity(value), offset: 0, length: 1 }],
    });
  }
  function picture(id: string, source: string, alt: string) {
    const uploaded = media.get(JSON.stringify([id, source, alt])) || media.get(source);
    if (uploaded)
      atomic(id, { type: "image", mutability: "immutable", data: { media_items: [uploaded], caption: alt } });
    else {
      issue(id, "imageNeedsUpload", "warning");
      blocks.push({ key: `${id}:${blocks.length}`, type: "unstyled", text: alt || source });
    }
  }
  function paragraph(id: string, type: XArticleBlock["type"], inline: Inline[]) {
    const block: XArticleBlock = {
      key: `${id}:${blocks.length}`,
      type,
      text: "",
      entity_ranges: [],
      inline_style_ranges: [],
    };
    const pictures: Extract<Inline, { kind: "image" }>[] = [];
    function append(items: Inline[]) {
      for (const item of items) {
        const offset = block.text.length;
        switch (item.kind) {
          case "text":
          case "opaque":
            block.text += item.text;
            break;
          case "code":
            block.text += item.text;
            issue(id, "unsupportedStyle");
            break;
          case "underline":
            append(item.children);
            issue(id, "unsupportedStyle");
            break;
          case "break":
            block.text += "\n";
            break;
          case "image":
            pictures.push(item);
            break;
          case "link": {
            append(item.children);
            if (safeLink(item.href))
              block.entity_ranges!.push({
                key: entity({ type: "link", mutability: "mutable", data: { url: item.href } }),
                offset,
                length: block.text.length - offset,
              });
            else {
              const code = unsupportedLink(item.href);
              issue(id, code, code === "unsafeLink" ? "blocking" : "warning");
              if (code === "unresolvedLink") block.text += ` (${item.href})`;
            }
            break;
          }
          case "strong":
          case "emphasis":
          case "strike":
            append(item.children);
            block.inline_style_ranges!.push({
              style: item.kind === "strong" ? "bold" : item.kind === "emphasis" ? "italic" : "strikethrough",
              offset,
              length: block.text.length - offset,
            });
        }
      }
    }
    append(inline);
    if (block.text) blocks.push(block);
    if (block.text && pictures.length) issue(id, "structuredTextFlattened");
    for (const image of pictures) picture(id, image.source, image.alt);
  }
  function picturesIn(block: ContentBlock) {
    for (const image of contentImages({ ...ir, blocks: [block] })) picture(image.blockId, image.source, image.alt);
  }
  function markdown(id: string, text: string) {
    markdownWeight += parseTweet(text).weightedLength;
    atomic(id, { type: "markdown", mutability: "mutable", data: { markdown: text } });
  }
  function visit(block: ContentBlock) {
    switch (block.kind) {
      case "paragraph":
        paragraph(block.id, "unstyled", block.inline);
        break;
      case "heading":
        if (block.level > 3) issue(block.id, "unsupportedStyle");
        paragraph(
          block.id,
          block.level === 1 ? "header-one" : block.level === 2 ? "header-two" : "header-three",
          block.inline,
        );
        break;
      case "code":
        markdown(block.id, block.raw);
        break;
      case "image":
        picture(block.id, block.source, block.alt);
        break;
      case "grid":
        markdown(block.id, gridMarkdown(block));
        picturesIn(block);
        issue(block.id, "structuredTextFlattened");
        break;
      case "table": {
        if (contentImages({ ...ir, blocks: [block] }).length) {
          const row = (cells: Inline[][]) =>
            "| " +
            cells.map((cell) => inlineText(cell).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ") +
            " |";
          markdown(
            block.id,
            [row(block.header), "| " + block.header.map(() => "---").join(" | ") + " |", ...block.rows.map(row)].join(
              "\n",
            ),
          );
          picturesIn(block);
          issue(block.id, "structuredTextFlattened");
        } else markdown(block.id, block.raw);
        break;
      }
      case "rule":
        atomic(block.id, { type: "divider", mutability: "immutable", data: {} });
        break;
      case "quote":
        for (const child of block.children) {
          if (child.kind === "paragraph") paragraph(child.id, "blockquote", child.inline);
          else {
            paragraph(child.id, "blockquote", [{ kind: "text", text: plainBlock(child) }]);
            picturesIn(child);
            issue(child.id, "structuredTextFlattened");
          }
        }
        break;
      case "list":
        for (const [index, item] of block.items.entries()) {
          if (
            item.children.length === 1 &&
            item.children[0]?.kind === "paragraph" &&
            block.start === 1 &&
            item.checked === undefined
          )
            paragraph(
              item.children[0].id,
              block.ordered ? "ordered-list-item" : "unordered-list-item",
              item.children[0].inline,
            );
          else {
            const itemBlock = { ...block, start: block.start + index, items: [item] };
            paragraph(block.id, "unstyled", [{ kind: "text", text: plainBlock(itemBlock) }]);
            picturesIn(itemBlock);
            issue(block.id, "structuredTextFlattened");
          }
        }
        break;
      case "container":
        if (block.title) paragraph(block.id, "header-two", [{ kind: "text", text: block.title }]);
        if (block.image) picture(block.id, block.image.source, block.image.alt);
        block.children.forEach(visit);
        break;
      case "opaque":
        paragraph(block.id, "unstyled", [{ kind: "text", text: block.raw }]);
        break;
    }
  }
  ir.blocks.forEach(visit);
  if (markdownWeight > 10_000) issue("article", "articleMarkdownLimit", "blocking");
  return { payload: { title: ir.title, content_state: { blocks, entities } }, issues };
}
