import type { Editor } from "@tiptap/core";

/** The command adapter is shared by fixed, selection, insertion and block menus. */
export async function runRichCommand(
  editor: Editor,
  name: string,
  ports: { image(): void; link(current: string): Promise<string | null> },
): Promise<void> {
  if (editor.isDestroyed || !editor.isEditable) return;
  const chain = editor.chain().focus();
  switch (name) {
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "underline":
      chain.toggleUnderline().run();
      break;
    case "strike":
      chain.toggleStrike().run();
      break;
    case "bulletList":
      chain.toggleBulletList().run();
      break;
    case "orderedList":
      chain.toggleOrderedList().run();
      break;
    case "taskList":
      chain.toggleTaskList().run();
      break;
    case "blockquote":
      chain.toggleBlockquote().run();
      break;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "horizontalRule":
      chain.setHorizontalRule().run();
      break;
    case "left":
    case "center":
    case "right":
      chain.setTextAlign(name).run();
      break;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "row":
      chain.addRowAfter().run();
      break;
    case "column":
      chain.addColumnAfter().run();
      break;
    case "removeRow":
      chain.deleteRow().run();
      break;
    case "removeColumn":
      chain.deleteColumn().run();
      break;
    case "removeTable":
      chain.deleteTable().run();
      break;
    case "undo":
      chain.undo().run();
      break;
    case "redo":
      chain.redo().run();
      break;
    case "image":
      ports.image();
      break;
    case "link": {
      const href = await ports.link(String(editor.getAttributes("link").href || ""));
      if (editor.isDestroyed || href === null) return;
      if (href) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      else editor.chain().focus().unsetLink().run();
      break;
    }
  }
}

export function setRichHeading(editor: Editor, level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > 6 || !editor.isEditable) return;
  if (level)
    editor
      .chain()
      .focus()
      .setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
  else editor.chain().focus().setParagraph().run();
}
