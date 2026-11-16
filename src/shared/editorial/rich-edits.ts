import { normalizeRichBody, type RichDocumentBody, type RichTextNode } from "../documents/rich-body.js";
import type { RichTextEdit } from "./contracts.js";

export const EDITORIAL_LIMITS = { edits: 500, editBytes: 65536 };
export class EditorialPatchError extends Error {}
const protectedNode = (node: RichTextNode) =>
  ["codeBlock", "blockquote"].includes(node.type) || node.marks?.some((mark) => ["code", "link"].includes(mark.type));

/** Canonical node paths address one immutable revision; formatting, image ownership and structure stay intact. */
export function editableRichLeaf(body: RichDocumentBody, path: number[]): RichTextNode {
  if (
    !Array.isArray(path) ||
    !path.length ||
    path.length > 32 ||
    path.some((index) => !Number.isSafeInteger(index) || index < 0)
  )
    throw new EditorialPatchError("invalidPatch");
  let node = body.document;
  for (const index of path) {
    if (protectedNode(node)) throw new EditorialPatchError("protectedText");
    const next = node.content?.[index];
    if (!next) throw new EditorialPatchError("invalidPatch");
    node = next;
  }
  if (node.type !== "text" || protectedNode(node)) throw new EditorialPatchError("protectedText");
  return node;
}
function boundaries(text: string, positions: number[]): boolean {
  if (positions.some((position) => !Number.isSafeInteger(position) || position < 0 || position > text.length))
    return false;
  const pending = new Set(positions);
  pending.delete(0);
  pending.delete(text.length);
  if (!pending.size) return true;
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const segment of segmenter.segment(text)) {
    pending.delete(segment.index);
    if (!pending.size) return true;
  }
  return false;
}
/** Apply the selected edits together or fail. Paths remain stable until every text replacement is complete. */
export function applyRichTextEdits(source: RichDocumentBody, edits: RichTextEdit[]): RichDocumentBody {
  if (!Array.isArray(edits) || !edits.length || edits.length > EDITORIAL_LIMITS.edits)
    throw new EditorialPatchError("invalidPatch");
  const body = normalizeRichBody(source),
    groups = new Map<string, { node: RichTextNode; edits: RichTextEdit[] }>(),
    ids = new Set<string>();
  let replacementBytes = 0;
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.id !== "string" ||
      !edit.id ||
      ids.has(edit.id) ||
      typeof edit.before !== "string" ||
      typeof edit.after !== "string" ||
      edit.before === edit.after ||
      edit.after.includes("\0") ||
      new TextEncoder().encode(edit.before + edit.after).length > EDITORIAL_LIMITS.editBytes
    )
      throw new EditorialPatchError("invalidPatch");
    ids.add(edit.id);
    replacementBytes += new TextEncoder().encode(edit.after).length;
    if (replacementBytes > 2 * 1024 * 1024) throw new EditorialPatchError("invalidPatch");
    const node = editableRichLeaf(body, edit.path),
      text = node.text || "";
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.end < edit.start ||
      text.slice(edit.start, edit.end) !== edit.before
    )
      throw new EditorialPatchError("sourceMismatch");
    const key = edit.path.join("."),
      group = groups.get(key) || { node, edits: [] };
    group.edits.push(edit);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = group.edits.sort((a, b) => a.start - b.start || a.end - b.end);
    if (
      !boundaries(
        group.node.text || "",
        ordered.flatMap((edit) => [edit.start, edit.end]),
      )
    )
      throw new EditorialPatchError("sourceMismatch");
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!,
        current = ordered[index]!;
      if (current.start < previous.end || current.start === previous.start)
        throw new EditorialPatchError("overlappingEdits");
    }
    let text = group.node.text || "";
    for (const edit of ordered.toReversed()) text = text.slice(0, edit.start) + edit.after + text.slice(edit.end);
    group.node.text = text;
  }
  const clean = (node: RichTextNode) => {
    if (!node.content) return;
    node.content = node.content.filter((child) => child.type !== "text" || child.text !== "");
    node.content.forEach(clean);
  };
  clean(body.document);
  return normalizeRichBody(body);
}
