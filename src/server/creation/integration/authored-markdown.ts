import { MarkdownManager } from "@tiptap/markdown";
import { documentEditorExtensions } from "../../../shared/documents/editor-schema.js";
import { richImageId, type RichDocumentBody, type RichTextNode } from "../../../shared/documents/rich-body.js";
import { richDocumentInput } from "../../documents/rich-codec.js";
import { CreationError } from "../contracts.js";
import { creationText } from "../validation.js";

const markdown = new MarkdownManager({ extensions: documentEditorExtensions() });
/** Rewrites validated image nodes only; literal IDs, code and prose are never string-replaced. */
export function authoredMarkdown(
  title: string,
  body: RichDocumentBody,
  images: ReadonlyMap<string, string> = new Map(),
) {
  const source = structuredClone(richDocumentInput(body).body.document),
    heading = creationText(title, 200),
    text = (node: RichTextNode): string => node.text || (node.content || []).map(text).join("");
  const visit = (node: RichTextNode) => {
    if (node.type === "image") {
      const path = images.get(richImageId(node.attrs?.src));
      if (!path || !/^creation-assets-[a-f0-9-]{36}\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path))
        throw new CreationError("invalidOutput");
      node.attrs = { ...node.attrs, src: path };
    }
    node.content?.forEach(visit);
  };
  visit(source);
  const first = source.content?.[0];
  if (!(first?.type === "heading" && first.attrs?.level === 1 && text(first) === heading))
    source.content = [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: heading }] },
      ...(source.content || []),
    ];
  return markdown.serialize(source).trimEnd() + "\n";
}
