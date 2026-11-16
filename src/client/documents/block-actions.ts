import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { MarkdownManager } from "@tiptap/markdown";
import type { MessageId } from "../../shared/i18n/messages.js";
import { applyBlockFormat, blockSupportsFormat, isBlockFormat } from "./block-format.js";
export interface DocumentBlockTarget {
  position: number;
  node: Node;
}
export const blockActions = [
  { id: "paragraph", label: "documents.formatParagraph", icon: "file" },
  { id: "heading1", label: "documents.formatHeading1", icon: "file" },
  { id: "heading2", label: "documents.formatHeading2", icon: "file" },
  { id: "heading3", label: "documents.formatHeading3", icon: "file" },
  { id: "bulletList", label: "documents.formatBulletList", icon: "list" },
  { id: "orderedList", label: "documents.formatOrderedList", icon: "listOrdered" },
  { id: "blockquote", label: "documents.formatQuote", icon: "quote" },
  { id: "codeBlock", label: "documents.formatCodeBlock", icon: "code" },
  { id: "copy", label: "documents.copyBlock", icon: "copy" },
  { id: "duplicate", label: "documents.duplicateBlock", icon: "copy" },
  { id: "up", label: "documents.moveBlockUp", icon: "chevronUp" },
  { id: "down", label: "documents.moveBlockDown", icon: "chevronDown" },
  { id: "delete", label: "documents.deleteBlock", icon: "trash" },
] as const satisfies readonly { id: string; label: MessageId; icon: string }[];
export type BlockActionId = (typeof blockActions)[number]["id"];
export function blockActionAvailable(editor: Editor, target: DocumentBlockTarget, id: BlockActionId) {
  if (!editor.isEditable || !editor.state.doc.nodeAt(target.position)?.eq(target.node)) return false;
  if (id === "up") return target.position > 0;
  if (id === "down") return target.position + target.node.nodeSize < editor.state.doc.content.size;
  if (["copy", "duplicate", "delete"].includes(id)) return true;
  return isBlockFormat(id) && blockSupportsFormat(target.node);
}
/** Whole-block actions validate the immutable target again and preserve the editor's normal undo history. */
export async function runBlockAction(
  editor: Editor,
  target: DocumentBlockTarget,
  id: BlockActionId,
  markdown: MarkdownManager,
) {
  if (!blockActionAvailable(editor, target, id)) return;
  const { position, node } = target,
    end = position + node.nodeSize;
  if (id === "copy") {
    await navigator.clipboard.writeText(markdown.serialize({ type: "doc", content: [node.toJSON()] }));
    if (!editor.isDestroyed && editor.isEditable) editor.view.focus();
    return;
  }
  editor.view.dispatch(closeHistory(editor.state.tr));
  if (id === "duplicate") {
    editor.chain().focus().insertContentAt(end, node.toJSON()).run();
    return;
  }
  if (id === "delete") {
    editor.chain().focus().deleteRange({ from: position, to: end }).run();
    return;
  }
  if (id === "up" || id === "down") {
    let previous = 0;
    editor.state.doc.forEach((child, offset) => {
      if (offset < position) previous = offset;
    });
    const next = editor.state.doc.nodeAt(end),
      destination = id === "up" ? previous : position + (next?.nodeSize ?? 0),
      tr = editor.state.tr.delete(position, end).insert(destination, node);
    editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, destination)).scrollIntoView());
    // Restore focus with the committed selection before WebKit can report a previous DOM range.
    editor.view.focus();
    return;
  }
  editor.commands.setNodeSelection(position);
  if (isBlockFormat(id) && !applyBlockFormat(editor, node, id))
    throw new Error("The selected block cannot be converted");
}
