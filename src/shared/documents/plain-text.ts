import { Marked, type Token } from "marked";
import type { DocumentRevision } from "./contracts.js";
import type { RichTextNode } from "./rich-body.js";

interface Block {
  text: string;
  level?: number;
}
const markdown = new Marked({ gfm: true });

function tokenText(token: Token): string {
  if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens.map(tokenText).join("");
  if (token.type === "image") return token.text;
  if (token.type === "br") return "\n";
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}
function richText(node: RichTextNode): string {
  if (node.text) return node.text;
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image") return typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  return (node.content ?? [])
    .map(richText)
    .join(
      [
        "doc",
        "bulletList",
        "orderedList",
        "taskList",
        "blockquote",
        "table",
        "tableRow",
        "tableCell",
        "tableHeader",
        "listItem",
        "taskItem",
      ].includes(node.type)
        ? "\n"
        : "",
    );
}

/** Text and section offsets are derived together from the immutable saved source used for evidence. */
export function savedDocumentText(revision: Pick<DocumentRevision, "body" | "content">) {
  const blocks: Block[] = revision.body
    ? (revision.body.document.content ?? []).map((node) => ({
        text: richText(node),
        ...(node.type === "heading" ? { level: Number(node.attrs?.level) } : {}),
      }))
    : markdown
        .lexer(revision.content)
        .filter((token) => token.type !== "space")
        .map((token) => ({ text: tokenText(token), ...(token.type === "heading" ? { level: token.depth } : {}) }));
  let text = "";
  const headings: { id: string; start: number; end: number; level: number }[] = [];
  for (const block of blocks) {
    if (text) text += "\n\n";
    if (block.level) {
      for (const heading of headings) if (heading.end < 0 && heading.level >= block.level) heading.end = text.length;
      headings.push({ id: "section-" + (headings.length + 1), start: text.length, end: -1, level: block.level });
    }
    text += block.text;
  }
  return { text, sections: headings.map(({ id, start, end }) => ({ id, start, end: end < 0 ? text.length : end })) };
}
