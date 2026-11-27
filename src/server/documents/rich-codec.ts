import { getSchema } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { MarkdownManager } from "@tiptap/markdown";
import { documentEditorExtensions } from "../../shared/documents/editor-schema.js";
import {
  normalizeRichBody,
  richBodyImageIds,
  type RichDocumentBody,
  type RichTextNode,
} from "../../shared/documents/rich-body.js";
import { contentText } from "./validation.js";
import { DocumentError } from "./errors.js";

const extensions = documentEditorExtensions(),
  schema = getSchema(extensions),
  markdown = new MarkdownManager({ extensions });
/** Import is explicit: raw Markdown remains in its original source; the result is an editable rich projection. */
export function richDocumentFromMarkdown(value: string, resolveImage?: (source: string) => string): RichDocumentBody {
  const document = markdown.parse(contentText(value));
  if (resolveImage) {
    const visit = (node: RichTextNode) => {
      if (node.type === "image" && typeof node.attrs?.src === "string") node.attrs.src = resolveImage(node.attrs.src);
      node.content?.forEach(visit);
    };
    visit(document as RichTextNode);
  }
  return richDocumentInput({ schema: 1, format: "richtext", document }).body;
}
/** Canonical rich source is validated headlessly. A derived Markdown view preserves existing integrations. */
export function richDocumentInput(value: unknown): { body: RichDocumentBody; content: string; images: string[] } {
  try {
    const body = normalizeRichBody(value),
      node = schema.nodeFromJSON(body.document);
    node.check();
    node.descendants((child) => {
      if (child.type.name === "table" && (TableMap.get(child).problems?.length || child.childCount > 100))
        throw new Error("Invalid table");
    });
    return { body, content: contentText(markdown.serialize(body.document)), images: richBodyImageIds(body) };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("invalidRichBody");
  }
}
