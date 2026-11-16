import type { Editor } from "@tiptap/core";
import type { Translate } from "../../shared/i18n/messages.js";
import { setMessageHtml, localizeAttribute } from "../i18n.js";
import { richActionButton } from "./rich-actions.js";
import { placeDocumentPopover, documentOverlayHost } from "./rich-popover.js";

/** Both the document header and editor toolbar open this one real-capability insertion menu. */
export class DocumentInsertMenu {
  private menu = document.createElement("div");
  private listeners = new AbortController();
  private anchor: HTMLElement | null = null;
  constructor(
    private editor: Editor,
    t: Translate,
    private command: (id: string) => Promise<void>,
    private error: (error: unknown) => void,
  ) {
    this.menu.className = "document-insert-menu document-rich-popover";
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    localizeAttribute(this.menu, "aria-label", "documents.insertContent", undefined, t);
    setMessageHtml(
      this.menu,
      (["table", "image", "codeBlock", "blockquote", "taskList"] as const)
        .map((id) => richActionButton(t, id, "data-insert-action", true))
        .join(""),
    );
    for (const button of this.menu.querySelectorAll("button")) button.setAttribute("role", "menuitem");
    documentOverlayHost(editor.view.dom).append(this.menu);
    const signal = this.listeners.signal;
    this.menu.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
    this.menu.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-insert-action]");
        if (button) {
          this.hide();
          void this.command(button.dataset.insertAction!).catch(this.error);
        }
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.menu.contains(event.target as Node) && !this.anchor?.contains(event.target as Node)) this.hide();
      },
      { signal },
    );
    document.addEventListener(
      "scroll",
      (event) => {
        if (!this.menu.contains(event.target as Node)) this.hide();
      },
      { capture: true, passive: true, signal },
    );
    window.addEventListener("resize", () => this.hide(), { signal });
    this.menu.addEventListener(
      "keydown",
      (event) => {
        const buttons = [...this.menu.querySelectorAll<HTMLButtonElement>("button")],
          index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          this.hide(true);
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      },
      { signal },
    );
  }
  open(anchor: HTMLElement) {
    if (!this.editor.isEditable) return;
    if (!this.menu.hidden && this.anchor === anchor) {
      this.hide(true);
      return;
    }
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    const canvas = this.editor.view.dom.closest(".document-canvas") ?? this.editor.view.dom;
    placeDocumentPopover(this.menu, anchor.getBoundingClientRect(), canvas.getBoundingClientRect());
    this.menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }
  hide(restore = false) {
    this.menu.hidden = true;
    this.anchor?.setAttribute("aria-expanded", "false");
    if (restore) this.anchor?.focus({ preventScroll: true });
  }
  close() {
    this.listeners.abort();
    this.menu.remove();
  }
}
