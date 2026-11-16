import { stableJson } from "../stable-json.js";

export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
}
/** Versioned editor-neutral source. Markdown is an exchange projection, not the rich document's identity. */
export interface RichDocumentBody {
  schema: 1;
  format: "richtext";
  document: RichTextNode;
}
export const RICH_DOCUMENT_LIMITS = { bytes: 2 * 1024 * 1024, nodes: 20000, depth: 32 };
export class RichDocumentError extends Error {}
const nodeAttributes: Record<string, string[]> = {
  doc: [],
  paragraph: ["textAlign"],
  heading: ["level", "textAlign"],
  text: [],
  hardBreak: [],
  horizontalRule: [],
  blockquote: [],
  codeBlock: ["language"],
  bulletList: [],
  orderedList: ["start", "type"],
  listItem: [],
  taskList: [],
  taskItem: ["checked"],
  table: [],
  tableRow: [],
  tableHeader: ["colspan", "rowspan", "colwidth", "align"],
  tableCell: ["colspan", "rowspan", "colwidth", "align"],
  image: ["src", "alt", "title", "width", "height"],
};
const markAttributes: Record<string, string[]> = {
  bold: [],
  italic: [],
  strike: [],
  underline: [],
  code: [],
  link: ["href", "target", "rel", "class", "title"],
};
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new RichDocumentError("invalidBody");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new RichDocumentError("invalidBody");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new RichDocumentError("invalidBody");
  return Number(value);
}
export function richImageId(source: unknown): string {
  const url = new URL(string(source, 200), "https://panda.invalid");
  const id = url.searchParams.get("id") || "";
  if (
    url.origin !== "https://panda.invalid" ||
    url.pathname !== "/api/document-assets/content" ||
    url.hash ||
    [...url.searchParams.keys()].join() !== "id" ||
    !/^[a-f0-9-]{36}$/.test(id)
  )
    throw new RichDocumentError("invalidImage");
  return id;
}
export function richLink(value: unknown): string {
  const href = string(value, 2048);
  if (/[\p{Cc}\p{Cf}]/u.test(href) || !href.trim()) throw new RichDocumentError("invalidLink");
  const url = new URL(href, "https://panda.invalid");
  if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password)
    throw new RichDocumentError("invalidLink");
  return href;
}
/** Closed data validation precedes editor schema validation on the server; no supplied HTML is executed. */
export function normalizeRichBody(value: unknown): RichDocumentBody {
  const input = record(value, ["schema", "format", "document"]);
  if (input.schema !== 1 || input.format !== "richtext") throw new RichDocumentError("unsupportedBody");
  let nodes = 0;
  const visit = (value: unknown, depth: number): RichTextNode => {
    if (++nodes > RICH_DOCUMENT_LIMITS.nodes || depth > RICH_DOCUMENT_LIMITS.depth)
      throw new RichDocumentError("bodyTooLarge");
    const node = record(value, ["type", "attrs", "content", "text", "marks"]),
      type = string(node.type, 30);
    if (!Object.hasOwn(nodeAttributes, type)) throw new RichDocumentError("unsupportedNode");
    const attrs = record(node.attrs ?? {}, nodeAttributes[type]!),
      output: RichTextNode = { type },
      normalized: Record<string, unknown> = {};
    if (type === "text") {
      output.text = string(node.text, RICH_DOCUMENT_LIMITS.bytes);
      if (!output.text || node.content !== undefined) throw new RichDocumentError("invalidBody");
    } else if (node.text !== undefined) throw new RichDocumentError("invalidBody");
    if (type === "heading") normalized.level = integer(attrs.level, 1, 6);
    if (attrs.textAlign !== undefined && attrs.textAlign !== null) {
      if (!["left", "center", "right", "justify"].includes(String(attrs.textAlign)))
        throw new RichDocumentError("invalidBody");
      normalized.textAlign = attrs.textAlign;
    }
    if (type === "codeBlock" && attrs.language !== undefined && attrs.language !== null)
      normalized.language = string(attrs.language, 80);
    if (type === "orderedList") {
      normalized.start = integer(attrs.start ?? 1, 1, 1000000);
      if (attrs.type !== undefined && attrs.type !== null) {
        if (!["1", "a", "A", "i", "I"].includes(String(attrs.type))) throw new RichDocumentError("invalidBody");
        normalized.type = attrs.type;
      }
    }
    if (type === "taskItem") {
      if (typeof attrs.checked !== "boolean") throw new RichDocumentError("invalidBody");
      normalized.checked = attrs.checked;
    }
    if (type === "tableCell" || type === "tableHeader") {
      normalized.colspan = integer(attrs.colspan ?? 1, 1, 32);
      normalized.rowspan = integer(attrs.rowspan ?? 1, 1, 100);
      if (attrs.colwidth !== undefined && attrs.colwidth !== null) {
        if (!Array.isArray(attrs.colwidth) || attrs.colwidth.length !== normalized.colspan)
          throw new RichDocumentError("invalidBody");
        normalized.colwidth = attrs.colwidth.map((width) => integer(width, 1, 4000));
      }
      if (attrs.align !== undefined && attrs.align !== null) {
        if (!["left", "center", "right"].includes(String(attrs.align))) throw new RichDocumentError("invalidBody");
        normalized.align = attrs.align;
      }
    }
    if (type === "image") {
      normalized.src = "/api/document-assets/content?id=" + richImageId(attrs.src);
      normalized.alt = string(attrs.alt ?? "", 1000);
      normalized.title = string(attrs.title ?? "", 1000);
      for (const dimension of ["width", "height"])
        if (attrs[dimension] !== undefined && attrs[dimension] !== null)
          normalized[dimension] = integer(attrs[dimension], 1, 20000);
    }
    if (Object.keys(normalized).length) output.attrs = normalized;
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new RichDocumentError("invalidBody");
      output.content = node.content.map((child) => visit(child, depth + 1));
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks) || node.marks.length > 7) throw new RichDocumentError("invalidBody");
      const seen = new Set<string>();
      output.marks = node.marks
        .map((value) => {
          const mark = record(value, ["type", "attrs"]),
            type = string(mark.type, 30);
          if (!Object.hasOwn(markAttributes, type) || seen.has(type)) throw new RichDocumentError("invalidBody");
          seen.add(type);
          const attrs = record(mark.attrs ?? {}, markAttributes[type]!);
          return type === "link"
            ? {
                type,
                attrs: {
                  href: richLink(attrs.href),
                  target: "_blank",
                  rel: "noopener noreferrer nofollow",
                  ...(attrs.title === undefined || attrs.title === null ? {} : { title: string(attrs.title, 1000) }),
                },
              }
            : { type };
        })
        .sort((a, b) => a.type.localeCompare(b.type, "en"));
    }
    return output;
  };
  const body: RichDocumentBody = { schema: 1, format: "richtext", document: visit(input.document, 0) };
  if (body.document.type !== "doc" || new TextEncoder().encode(stableJson(body)).length > RICH_DOCUMENT_LIMITS.bytes)
    throw new RichDocumentError("invalidBody");
  return body;
}
export function richBodyImageIds(body: RichDocumentBody): string[] {
  const ids = new Set<string>();
  const visit = (node: RichTextNode) => {
    if (node.type === "image") ids.add(richImageId(node.attrs?.src));
    node.content?.forEach(visit);
  };
  visit(body.document);
  return [...ids];
}
export const emptyRichBody = (): RichDocumentBody => ({
  schema: 1,
  format: "richtext",
  document: { type: "doc", content: [{ type: "paragraph" }] },
});
