import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { TextSelection, Selection } from "@tiptap/pm/state";
import { Compartment, EditorState, type StateEffect } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection, type ViewUpdate } from "@codemirror/view";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import type { Translate } from "../../../shared/i18n/messages.js";
import { codeHighlightAllowed } from "./limits.js";
import { documentCodeLanguage } from "./languages.js";
import { documentCodeTheme, documentCodeHighlighting } from "./theme.js";
import type { CodeLanguagePicker } from "./language-picker.js";
import { codeBlockPhrases } from "./phrases.js";
import { CodeBlockControls } from "./controls.js";

/** Mirrors canonical plain code and selection into the document. Decorations, folds, wrapping and controls never enter source JSON. */
export class DocumentCodeBlockView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly language = new Compartment();
  private readonly mode = new Compartment();
  private readonly wrapping = new Compartment();
  private readonly toolbar: CodeBlockControls;
  private readonly mirror: EditorView;
  private updating = false;
  private closed = false;
  private forwarding = false;
  private syntaxKey = "";
  constructor(
    private node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly getPos: () => number | undefined,
    picker: CodeLanguagePicker,
    t: Translate,
    error: (value: unknown) => void,
  ) {
    this.dom.className = "document-code-block";
    this.dom.contentEditable = "false";
    const content = document.createElement("div");
    this.toolbar = new CodeBlockControls(
      t,
      {
        text: () => this.node.textContent,
        language: () => String(this.node.attrs.language || "plaintext"),
        editable: () => this.editor.isEditable,
        setLanguage: (value) => {
          const position = this.getPos();
          if (!this.closed && position !== undefined)
            this.editor.view.dispatch(
              this.editor.state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, language: value }),
            );
        },
        setWrap: (wrap) =>
          this.mirror.dispatch({ effects: this.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }),
        error,
      },
      picker,
    );
    this.dom.append(this.toolbar.element, content);
    this.mirror = new EditorView({
      parent: content,
      doc: node.textContent,
      extensions: [
        EditorState.phrases.of(codeBlockPhrases(t)),
        this.language.of(this.syntax()),
        this.mode.of(this.editableExtensions()),
        this.wrapping.of(this.toolbar.wrap ? EditorView.lineWrapping : []),
        lineNumbers(),
        foldGutter(),
        bracketMatching(),
        indentOnInput(),
        closeBrackets(),
        drawSelection(),
        documentCodeTheme,
        documentCodeHighlighting,
        EditorView.contentAttributes.of({ "aria-label": t("codeBlocks.content"), spellcheck: "false", tabindex: "0" }),
        keymap.of([
          { key: "Mod-z", run: () => this.history(false), shift: () => this.history(true) },
          { key: "Mod-y", run: () => this.history(true) },
          { key: "Mod-Enter", run: () => this.exit() },
          { key: "ArrowUp", run: () => this.moveOut(-1) },
          { key: "ArrowDown", run: () => this.moveOut(1) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => this.forward(update)),
      ],
    });
    this.syntaxKey = this.currentSyntaxKey();
    this.controls();
  }
  private currentSyntaxKey() {
    return String(this.node.attrs.language || "plaintext") + ":" + codeHighlightAllowed(this.node.textContent);
  }
  private syntax() {
    return !codeHighlightAllowed(this.node.textContent)
      ? []
      : (documentCodeLanguage(this.node.attrs.language)?.syntax() ?? []);
  }
  private editableExtensions() {
    return [EditorState.readOnly.of(!this.editor.isEditable), EditorView.editable.of(this.editor.isEditable)];
  }
  private controls() {
    this.toolbar.update();
    this.dom.dataset.codeBlockLanguage = String(this.node.attrs.language || "plaintext");
  }
  private forward(update: ViewUpdate) {
    if (this.updating || this.closed || !update.view.hasFocus || !this.editor.isEditable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const base = position + 1,
      transaction = this.editor.state.tr;
    if (update.docChanged) {
      let offset = base;
      update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
        transaction.replaceWith(
          offset + fromA,
          offset + toA,
          text.length ? this.editor.schema.text(text.toString()) : [],
        );
        offset += toB - fromB - (toA - fromA);
      });
    }
    const selected = update.state.selection.main,
      selection = TextSelection.create(transaction.doc, base + selected.anchor, base + selected.head);
    if (!update.docChanged && this.editor.state.selection.eq(selection)) return;
    this.forwarding = true;
    try {
      this.editor.view.dispatch(transaction.setSelection(selection));
    } finally {
      this.forwarding = false;
    }
  }
  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.forwarding) {
      if (this.currentSyntaxKey() !== this.syntaxKey)
        queueMicrotask(() => {
          if (!this.closed) this.update(this.node);
        });
      this.controls();
      return true;
    }
    this.updating = true;
    try {
      const text = node.textContent,
        old = this.mirror.state.doc.toString(),
        effects: StateEffect<unknown>[] = [];
      if (this.currentSyntaxKey() !== this.syntaxKey) {
        this.syntaxKey = this.currentSyntaxKey();
        effects.push(this.language.reconfigure(this.syntax()));
      }
      if (old !== text) {
        let from = 0,
          oldEnd = old.length,
          newEnd = text.length;
        while (from < oldEnd && from < newEnd && old[from] === text[from]) from++;
        while (oldEnd > from && newEnd > from && old[oldEnd - 1] === text[newEnd - 1]) {
          oldEnd--;
          newEnd--;
        }
        this.mirror.dispatch({ changes: { from, to: oldEnd, insert: text.slice(from, newEnd) }, effects });
      } else if (effects.length) this.mirror.dispatch({ effects });
    } finally {
      this.updating = false;
    }
    this.controls();
    return true;
  }
  setSelection(anchor: number, head: number) {
    if (this.closed || this.forwarding) return;
    this.updating = true;
    try {
      this.mirror.focus();
      if (this.mirror.state.selection.main.anchor === anchor && this.mirror.state.selection.main.head === head) return;
      this.mirror.dispatch({ selection: { anchor, head } });
    } finally {
      this.updating = false;
    }
  }
  setEditable() {
    this.toolbar.setEditable();
    this.mirror.dispatch({ effects: this.mode.reconfigure(this.editableExtensions()) });
    this.controls();
  }
  private history(redo: boolean) {
    const changed = redo ? this.editor.commands.redo() : this.editor.commands.undo();
    this.editor.view.focus();
    return changed;
  }
  private moveOut(direction: -1 | 1) {
    const selected = this.mirror.state.selection.main;
    if (!selected.empty || (direction < 0 ? selected.head !== 0 : selected.head !== this.mirror.state.doc.length))
      return false;
    const position = this.getPos();
    if (position === undefined) return false;
    const target = direction < 0 ? position : position + this.node.nodeSize;
    this.editor.view.dispatch(
      this.editor.state.tr
        .setSelection(Selection.near(this.editor.state.doc.resolve(target), direction))
        .scrollIntoView(),
    );
    this.editor.view.focus();
    return true;
  }
  private exit() {
    if (!this.editor.isEditable) return false;
    const position = this.getPos();
    if (position === undefined) return false;
    this.editor.commands.setTextSelection(position + 1 + this.node.content.size);
    return this.editor.commands.exitCode();
  }
  stopEvent() {
    return true;
  }
  ignoreMutation() {
    return true;
  }
  destroy() {
    this.closed = true;
    this.toolbar.close();
    this.mirror.destroy();
  }
}
