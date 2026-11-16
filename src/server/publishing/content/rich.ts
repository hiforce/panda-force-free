import { contentSourceScope } from "../../../shared/publishing/source-scope.js";
import { createHash } from "node:crypto";
import { documentContentIdentity } from "../../../shared/documents/content-identity.js";
import { normalizeRichBody, type RichDocumentBody, type RichTextNode } from "../../../shared/documents/rich-body.js";
import type {
  BlockOrigin,
  ContentAlignment,
  ContentBlock,
  ContentIR,
  ContentIssue,
  Inline,
} from "../../../shared/publishing/content.js";
import type { ContentSource } from "./source-contract.js";
import { safeLink, unsupportedLink } from "./inline.js";

/** Read the validated source tree directly. The exchange Markdown never reconstructs rich semantics. */
export function parseRichContent(input: ContentSource, value: RichDocumentBody): ContentIR {
  const body = normalizeRichBody(value),
    source = input.content.replace(/\r\n?/g, "\n"),
    issues: ContentIssue[] = [];
  const issue = (blockId: string, code: ContentIssue["code"]) => {
    if (!issues.some((item) => item.blockId === blockId && item.code === code))
      issues.push({ blockId, code, severity: code === "unsafeLink" ? "blocking" : "warning" });
  };
  const text = (node: RichTextNode): string =>
    node.text || (node.type === "hardBreak" ? "\n" : (node.content || []).map(text).join(""));
  const origin = (path: number[]): BlockOrigin => ({
    id: `${input.revisionId}:r${path.join(".")}`,
    raw: "",
    richPath: path,
    span: { start: 0, end: source.length, exact: false },
  });
  function inline(node: RichTextNode, id: string): Inline[] {
    return (node.content || []).map((child): Inline => {
      if (child.type === "hardBreak") return { kind: "break" };
      if (child.type !== "text") throw new Error("Invalid rich inline node");
      let output: Inline = {
        kind: child.marks?.some((mark) => mark.type === "code") ? "code" : "text",
        text: child.text || "",
      };
      for (const mark of child.marks || []) {
        switch (mark.type) {
          case "code":
            break;
          case "bold":
            output = { kind: "strong", children: [output] };
            break;
          case "italic":
            output = { kind: "emphasis", children: [output] };
            break;
          case "strike":
            output = { kind: "strike", children: [output] };
            break;
          case "underline":
            output = { kind: "underline", children: [output] };
            break;
          case "link": {
            const href = String(mark.attrs?.href || "");
            if (!safeLink(href)) issue(id, unsupportedLink(href));
            output = { kind: "link", href, children: [output] };
            break;
          }
          default:
            throw new Error("Unsupported rich mark");
        }
      }
      return output;
    });
  }
  const children = (node: RichTextNode, path: number[]) =>
    (node.content || []).map((child, index) => block(child, [...path, index]));
  function block(node: RichTextNode, path: number[]): ContentBlock {
    const base = origin(path),
      attrs = node.attrs || {};
    switch (node.type) {
      case "paragraph":
      case "heading":
        return {
          ...base,
          ...(node.type === "heading" ? { kind: "heading", level: Number(attrs.level) } : { kind: "paragraph" }),
          ...(attrs.textAlign ? { align: attrs.textAlign as ContentAlignment } : {}),
          inline: inline(node, base.id),
        };
      case "horizontalRule":
        return { ...base, kind: "rule" };
      case "blockquote":
        return { ...base, kind: "quote", children: children(node, path) };
      case "codeBlock": {
        const content = text(node),
          language = String(attrs.language || ""),
          fence = "`".repeat((content.match(/`+/g) || []).reduce((length, run) => Math.max(length, run.length + 1), 3));
        return {
          ...base,
          raw: `${fence}${language.replace(/[\p{Cc}\p{Cf}`]/gu, "")}\n${content}\n${fence}`,
          kind: "code",
          language,
          text: content,
        };
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        return {
          ...base,
          kind: "list",
          ordered: node.type === "orderedList",
          start: Number(attrs.start || 1),
          ...(attrs.type ? { style: attrs.type as "1" | "a" | "A" | "i" | "I" } : {}),
          items: (node.content || []).map((item, index) => {
            if (item.type !== (node.type === "taskList" ? "taskItem" : "listItem"))
              throw new Error("Invalid rich list item");
            return {
              ...(item.type === "taskItem" ? { checked: Boolean(item.attrs?.checked) } : {}),
              children: children(item, [...path, index]),
            };
          }),
        };
      case "image":
        return {
          ...base,
          kind: "image",
          source: String(attrs.src),
          alt: String(attrs.alt || ""),
          ...(attrs.title ? { title: String(attrs.title) } : {}),
          ...(attrs.width ? { width: Number(attrs.width) } : {}),
          ...(attrs.height ? { height: Number(attrs.height) } : {}),
        };
      case "table":
        return {
          ...base,
          kind: "grid",
          rows: (node.content || []).map((row, rowIndex) => {
            if (row.type !== "tableRow") throw new Error("Invalid rich table row");
            return (row.content || []).map((cell, cellIndex) => {
              if (cell.type !== "tableHeader" && cell.type !== "tableCell") throw new Error("Invalid rich table cell");
              const properties = cell.attrs || {};
              return {
                header: cell.type === "tableHeader",
                colspan: Number(properties.colspan || 1),
                rowspan: Number(properties.rowspan || 1),
                ...(properties.colwidth ? { colwidth: properties.colwidth as number[] } : {}),
                ...(properties.align ? { align: properties.align as ContentAlignment } : {}),
                children: children(cell, [...path, rowIndex, cellIndex]),
              };
            });
          }),
        };
      default:
        throw new Error("Unsupported rich block");
    }
  }
  return {
    schema: 1,
    documentId: input.documentId,
    revisionId: input.revisionId,
    ...contentSourceScope(input),
    sourceHash: createHash("sha256").update(documentContentIdentity(input.content, body)).digest("hex"),
    title: input.title,
    locale: input.locale,
    source,
    origin: { kind: "richtext", body },
    frontmatter: "",
    blocks: children(body.document, []),
    issues,
  };
}
