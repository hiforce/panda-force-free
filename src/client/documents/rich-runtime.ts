import { createDocumentCodeBlocks } from "./code-block/extension.js";
import { Editor, Node, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { documentEditorExtensions } from "../../shared/documents/editor-schema.js";
import { normalizeRichBody, richImageId } from "../../shared/documents/rich-body.js";
import { setMessageHtml } from "../i18n.js";
import { DocumentApiError } from "./api.js";
import type { RichEditorPort, RichEditorOptions } from "./rich-port.js";
import { DocumentRichToolbar } from "./rich-toolbar.js";
import { runRichCommand, setRichHeading } from "./rich-commands.js";
import { SelectionToolbar } from "./selection-toolbar.js";
import { DocumentInsertMenu } from "./insert-menu.js";
import { DocumentBlockMenu } from "./block-menu.js";
import { collapseDocumentSelection } from "./rich-selection.js";

/** The lazy editor adapter owns source state; scoped views share commands and own their transient menus. */
export function createRichDocumentEditor(host: HTMLElement, options: RichEditorOptions): RichEditorPort {
  const { t } = options,
    codeBlocks = createDocumentCodeBlocks(t, options.error),
    extensions = [...documentEditorExtensions({ codeBlock: false }), codeBlocks.extension].map((extension) => {
      if (!(extension instanceof Node) || extension.name !== "image" || !options.imageUrl) return extension;
      return extension.extend({
        addNodeView() {
          return ({ node }) => {
            const img = document.createElement("img");
            img.src = options.imageUrl!(richImageId(node.attrs.src));
            img.alt = node.attrs.alt || "";
            img.title = node.attrs.title || "";
            return { dom: img };
          };
        },
      });
    }),
    markdown = new MarkdownManager({ extensions });
  const shell = document.createElement("div");
  shell.className = "document-rich-shell";
  setMessageHtml(
    shell,
    '<input type="file" data-rich-image accept="image/png,image/jpeg,image/webp" hidden><div class="document-rich-surface"></div>',
  );
  host.replaceChildren(shell);
  let disposed = false,
    editable = options.editable;
  const uploads = new Map<string, string>();
  const Upload = Node.create({
    name: "documentImageUpload",
    group: "block",
    atom: true,
    addAttributes() {
      return { id: { default: "" }, name: { default: "" }, failed: { default: false } };
    },
    renderHTML({ node }) {
      return [
        "div",
        { class: "document-image-upload", role: "status" },
        node.attrs.failed ? t("documents.imageUploadFailed") : t("documents.imageUploading", { name: node.attrs.name }),
      ];
    },
  });
  let editor: Editor,
    toolbar: DocumentRichToolbar | null = null;
  editor = new Editor({
    element: shell.querySelector<HTMLElement>(".document-rich-surface")!,
    extensions: [...extensions, Placeholder.configure({ placeholder: t("documents.richPlaceholder") }), Upload],
    content: options.body.document,
    editable,
    injectCSS: false,
    autofocus: false,
    editorProps: {
      handleKeyDown: collapseDocumentSelection,
      scrollThreshold: { top: 72, bottom: 16, left: 0, right: 0 },
      scrollMargin: { top: 72, bottom: 24, left: 16, right: 16 },
      attributes: {
        class: "document-rich-content",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("documents.richEditorLabel"),
        spellcheck: "true",
        "data-i18n-ignore": "",
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
        if (!editable) return false;
        const code = event.clipboardData?.getData("text/plain") || "";
        if (
          !files.length &&
          code.length <= 256 * 1024 &&
          /^(?:`{3,}|~{3,})[\w+-]*\r?\n[\s\S]*\r?\n(?:`{3,}|~{3,})\s*$/.test(code)
        ) {
          event.preventDefault();
          editor.chain().focus().insertContent(markdown.parse(code)).run();
          return true;
        }
        if (!files.length) return false;
        event.preventDefault();
        for (const file of files) void upload(file);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
        if (!editable || moved || !files.length) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (position) editor.commands.setTextSelection(position.pos);
        for (const file of files) void upload(file);
        return true;
      },
    },
    onUpdate() {
      if (!disposed && editor) {
        update();
        options.changed();
      }
    },
    onSelectionUpdate() {
      if (!disposed && editor) update();
    },
  });
  function update() {
    toolbar?.update(editable, editor.getAttributes("heading").level || 0, (name) => editor.isActive(name));
  }
  function position(id: string) {
    let found: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "documentImageUpload" && node.attrs.id === id) found = pos;
    });
    return found;
  }
  async function upload(file: File) {
    if (disposed || !editable) return;
    if (file.size > 8 * 1024 * 1024) {
      options.error(new DocumentApiError(413, { messageId: "documents.assetTooLarge" }));
      return;
    }
    const id = crypto.randomUUID();
    uploads.set(id, file.name);
    editor
      .chain()
      .focus()
      .insertContent({ type: "documentImageUpload", attrs: { id, name: file.name } })
      .run();
    try {
      const asset = await options.upload(file);
      if (disposed) return;
      const at = position(id);
      uploads.delete(id);
      if (at !== null) {
        const previous = editor.state.doc.nodeAt(at)!;
        editor.view.dispatch(
          editor.state.tr
            .replaceWith(
              at,
              at + previous.nodeSize,
              editor.schema.nodes.image!.create({
                src: "/api/document-assets/content?id=" + asset.id,
                alt: asset.alt || asset.name,
                title: asset.name,
              }),
            )
            .setMeta("addToHistory", false),
        );
      } else options.changed();
    } catch (error) {
      if (disposed) return;
      uploads.delete(id);
      const at = position(id);
      if (at !== null)
        editor.view.dispatch(
          editor.state.tr
            .setNodeMarkup(at, undefined, { id, name: file.name, failed: true })
            .setMeta("addToHistory", false),
        );
      options.error(error);
    }
  }
  async function command(name: string) {
    await runRichCommand(editor, name, {
      image: () => shell.querySelector<HTMLInputElement>("[data-rich-image]")!.click(),
      link: options.link,
    });
  }
  shell.querySelector<HTMLInputElement>("[data-rich-image]")!.onchange = (event) => {
    const field = event.target as HTMLInputElement,
      file = field.files?.[0];
    field.value = "";
    if (file) void upload(file);
  };
  const selectionToolbar = new SelectionToolbar(
    editor,
    t,
    command,
    (level) => setRichHeading(editor, level),
    options.error,
  );
  const insertMenu = new DocumentInsertMenu(editor, t, command, options.error);
  const blockMenu = new DocumentBlockMenu(editor, t, markdown, options.error);
  toolbar = new DocumentRichToolbar(
    options.toolbarHost || shell,
    t,
    {
      command,
      heading: (level) => setRichHeading(editor, level),
      block: (anchor) => blockMenu.open(anchor),
      insert: (anchor) => insertMenu.open(anchor),
      error: options.error,
    },
    !!options.toolbarHost,
  );
  update();
  return {
    get uploading() {
      return uploads.size > 0;
    },
    snapshot() {
      const clean = (node: JSONContent): JSONContent => {
        const content = node.content?.filter((child) => child.type !== "documentImageUpload").map(clean);
        if (
          content &&
          !content.length &&
          ["doc", "blockquote", "listItem", "taskItem", "tableCell", "tableHeader"].includes(node.type || "")
        )
          content.push({ type: "paragraph" });
        return { ...node, ...(content ? { content } : {}) };
      };
      const document = clean(editor.getJSON());
      if (!document.content?.length) document.content = [{ type: "paragraph" }];
      const body = normalizeRichBody({ schema: 1, format: "richtext", document });
      return { body, content: markdown.serialize(body.document) };
    },
    setEditable(value) {
      editable = value;
      editor.setEditable(value, false);
      codeBlocks.setEditable();
      update();
      if (!value) {
        insertMenu.hide();
        selectionToolbar.hide();
        blockMenu.clear();
      }
    },
    insertMarkdown(value) {
      if (editable) editor.chain().focus().insertContent(markdown.parse(value)).run();
    },
    focus(scrollIntoView = true) {
      editor.view.focus();
      if (scrollIntoView) editor.commands.scrollIntoView();
    },
    openInsertMenu(anchor) {
      insertMenu.open(anchor);
    },
    destroy() {
      disposed = true;
      toolbar?.close();
      selectionToolbar.close();
      insertMenu.close();
      blockMenu.close();
      uploads.clear();
      editor.destroy();
      codeBlocks.close();
      shell.remove();
    },
  };
}
