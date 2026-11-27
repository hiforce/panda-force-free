import type { DocumentEngine, DocumentResourceBinding } from "../../shared/documents/contracts.js";
import { renderDocumentMarkdown } from "../../shared/documents/render-markdown.js";
import { sanitizeRichText } from "../html-safety.js";

export function documentPreview(
  content: string,
  engine: DocumentEngine = "markdown",
  bindings: DocumentResourceBinding[] = [],
  imageUrl?: (id: string) => string,
): string {
  return sanitizeRichText(renderDocumentMarkdown(content, engine, bindings, imageUrl));
}
