import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { MarkdownManager } from "@tiptap/markdown";
import type { Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { localizeAttribute, messageHtml, setMessageHtml } from "../i18n.js";
import {
  blockActions,
  blockActionAvailable,
  runBlockAction,
  type BlockActionId,
  type DocumentBlockTarget,
} from "./block-actions.js";
import { placeDocumentPopover, documentOverlayHost } from "./rich-popover.js";

/** A block handle owns transient targeting; transaction mappings prevent actions from drifting onto another block. */
export class DocumentBlockMenu {
  private handle = document.createElement("button");
  private menu = document.createElement("div");
  private outline = document.createElement("div");
  private listeners = new AbortController();
  private target: DocumentBlockTarget | null = null;
  private hover = matchMedia("(min-width:701px) and (pointer:fine)");
  private remap = ({ transaction }: { transaction: Transaction }) => {
    if (!this.target) return;
    const mapped = transaction.mapping.mapResult(this.target.position),
      position = mapped.pos,
      node = transaction.doc.nodeAt(position);
    if (mapped.deleted || !node?.eq(this.target.node)) {
      this.clear();
      return;
    }
    this.target = { position, node };
    this.place();
  };
  private reposition = () => this.place();
  constructor(
    private editor: Editor,
    t: Translate,
    private markdown: MarkdownManager,
    private error: (error: unknown) => void,
  ) {
    this.handle.type = "button";
    this.handle.className = "document-block-handle";
    this.handle.hidden = true;
    this.handle.setAttribute("aria-haspopup", "menu");
    localizeAttribute(this.handle, "aria-label", "documents.blockActions", undefined, t);
    localizeAttribute(this.handle, "title", "documents.blockActions", undefined, t);
    setMessageHtml(this.handle, codexIcon("gripVertical"));
    this.menu.className = "document-block-menu document-rich-popover";
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    localizeAttribute(this.menu, "aria-label", "documents.blockActions", undefined, t);
    setMessageHtml(
      this.menu,
      blockActions
        .map(
          (item) =>
            `<button type="button" class="document-format-button${item.id === "delete" ? " danger" : ""}" data-block-action="${item.id}" role="menuitem">${codexIcon(item.icon)}${messageHtml(item.label, undefined, t)}</button>`,
        )
        .join(""),
    );
    this.outline.className = "document-block-outline";
    this.outline.hidden = true;
    this.outline.setAttribute("aria-hidden", "true");
    documentOverlayHost(editor.view.dom).append(this.outline, this.handle, this.menu);
    const signal = this.listeners.signal,
      canvas = this.canvas();
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (
          !this.hover.matches ||
          !this.editor.isEditable ||
          !this.menu.hidden ||
          !(event.target instanceof Node) ||
          !this.editor.view.dom.contains(event.target)
        )
          return;
        const found = this.editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (found) this.select(found.pos);
      },
      { signal },
    );
    canvas.addEventListener(
      "pointerleave",
      (event) => {
        if (this.menu.hidden && !this.handle.contains(event.relatedTarget as Node)) this.clear();
      },
      { signal },
    );
    this.handle.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
    this.handle.addEventListener("click", () => this.open(this.handle), { signal });
    this.menu.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
    this.menu.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-block-action]"),
          target = this.target;
        if (button && !button.disabled && target) {
          const id = button.dataset.blockAction as BlockActionId;
          this.clear();
          void runBlockAction(this.editor, target, id, this.markdown).catch(this.error);
        }
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.menu.contains(event.target as Node) && !this.handle.contains(event.target as Node)) this.clear();
      },
      { signal },
    );
    document.addEventListener("scroll", this.reposition, { capture: true, passive: true, signal });
    window.addEventListener("resize", () => this.clear(), { signal });
    this.menu.addEventListener(
      "keydown",
      (event) => {
        const nodes = [...this.menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")],
          index = nodes.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          this.clear();
          this.editor.commands.focus();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          nodes[(index + (event.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length]?.focus();
        }
      },
      { signal },
    );
    this.editor.on("transaction", this.remap);
    this.editor.view.dom.addEventListener(
      "keydown",
      (event) => {
        if (event.altKey && event.shiftKey && event.key.toLowerCase() === "m") {
          event.preventDefault();
          this.open();
        }
      },
      { signal },
    );
  }
  private canvas() {
    return this.editor.view.dom.closest<HTMLElement>(".document-canvas") ?? this.editor.view.dom;
  }
  private select(position: number) {
    const resolved = this.editor.state.doc.resolve(position),
      start = resolved.depth
        ? resolved.before(1)
        : position < this.editor.state.doc.content.size
          ? position
          : Math.max(0, this.editor.state.doc.content.size - (this.editor.state.doc.lastChild?.nodeSize ?? 0)),
      node = this.editor.state.doc.nodeAt(start);
    if (!node || node.type.name === "documentImageUpload") return;
    this.target = { position: start, node };
    this.place();
  }
  private place() {
    if (!this.target || this.editor.isDestroyed || !this.editor.isEditable) {
      this.clear();
      return;
    }
    const dom = this.editor.view.nodeDOM(this.target.position);
    if (!(dom instanceof HTMLElement)) {
      this.clear();
      return;
    }
    const rect = dom.getBoundingClientRect(),
      bounds = this.canvas().getBoundingClientRect();
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
      this.clear();
      return;
    }
    this.handle.hidden = !this.hover.matches;
    this.outline.hidden = !this.hover.matches;
    Object.assign(this.outline.style, {
      left: Math.max(bounds.left, rect.left) + "px",
      top: Math.max(bounds.top, rect.top) + "px",
      width: Math.max(0, Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left)) + "px",
      height: Math.max(0, Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top)) + "px",
    });
    this.handle.style.left = Math.max(bounds.left + 4, rect.left - 32) + "px";
    this.handle.style.top = Math.max(bounds.top + 4, rect.top) + "px";
    if (!this.menu.hidden) placeDocumentPopover(this.menu, this.handle.getBoundingClientRect(), bounds);
  }
  open(anchor?: HTMLElement) {
    if (!this.editor.isEditable) return;
    if (!this.target) this.select(this.editor.state.selection.from);
    if (!this.target) return;
    this.editor.commands.setNodeSelection(this.target.position);
    for (const button of this.menu.querySelectorAll<HTMLButtonElement>("[data-block-action]"))
      button.disabled = !blockActionAvailable(this.editor, this.target, button.dataset.blockAction as BlockActionId);
    placeDocumentPopover(
      this.menu,
      (anchor ?? this.handle).getBoundingClientRect(),
      this.canvas().getBoundingClientRect(),
    );
    this.handle.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  clear() {
    this.target = null;
    this.outline.hidden = true;
    this.handle.hidden = true;
    this.handle.setAttribute("aria-expanded", "false");
    this.menu.hidden = true;
  }
  close() {
    this.clear();
    this.listeners.abort();
    this.editor.off("transaction", this.remap);
    this.handle.remove();
    this.outline.remove();
    this.menu.remove();
  }
}
