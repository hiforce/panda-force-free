import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

const formats = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
] as const;
export type BlockFormatId = (typeof formats)[number];
const roots = new Set(["paragraph", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "taskList"]);
const children = new Set([...roots, "listItem", "taskItem", "text", "hardBreak"]);
export function isBlockFormat(id: string): id is BlockFormatId {
  return (formats as readonly string[]).includes(id);
}

/** Text-container conversion must not flatten tables, images or future provider-owned blocks. */
export function blockSupportsFormat(node: Node): boolean {
  if (!roots.has(node.type.name)) return false;
  let supported = true;
  node.descendants((child) => {
    if (!children.has(child.type.name)) supported = false;
    return supported;
  });
  return supported;
}

/** A block menu chooses a format; inline toolbars retain their separate toggle semantics. */
export function applyBlockFormat(editor: Editor, node: Node, id: BlockFormatId): boolean {
  if (node.type.name === id || (node.type.name === "heading" && id === `heading${node.attrs.level}`))
    return editor.commands.focus();
  const { from, to } = editor.state.selection;
  const chain = editor
    .chain()
    .focus()
    .clearNodes()
    .command(({ tr }) => {
      // Lifting a container can shrink a NodeSelection to its first child. Preserve the complete mapped range.
      const start = tr.mapping.map(from, 1),
        end = Math.max(start, tr.mapping.map(to, -1));
      tr.setSelection(TextSelection.between(tr.doc.resolve(start), tr.doc.resolve(end)));
      return true;
    });
  switch (id) {
    case "paragraph":
      return chain.run();
    case "heading1":
    case "heading2":
    case "heading3":
      return chain.setHeading({ level: Number(id.slice(-1)) as 1 | 2 | 3 }).run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "blockquote":
      return chain.setBlockquote().run();
    case "codeBlock":
      return chain.setCodeBlock().run();
  }
}
