import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Translate } from "../../shared/i18n/messages.js";
import { setMessageHtml, localizeAttribute } from "../i18n.js";
import { richActionButton, richHeadingSelect } from "./rich-actions.js";
import { placeDocumentPopover, documentOverlayHost } from "./rich-popover.js";

/** This transient view owns selection presentation only; commands and source mutation stay in the editor adapter. */
export class SelectionToolbar {
  private menu = document.createElement("div");
  private listeners = new AbortController();
  private frame = 0;
  private dragging = false;
  private dismissed = "";
  private desktop = matchMedia("(min-width:701px) and (pointer:fine)");
  private schedule = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.update());
  };
  constructor(
    private editor: Editor,
    t: Translate,
    private command: (id: string) => Promise<void>,
    private heading: (level: number) => void,
    private error: (error: unknown) => void,
  ) {
    this.menu.className = "document-selection-toolbar document-rich-popover";
    this.menu.hidden = true;
    setMessageHtml(
      this.menu,
      richHeadingSelect(t, "data-selection-heading") +
        (["bold", "italic", "underline", "strike", "link"] as const)
          .map((id) => richActionButton(t, id, "data-selection-action"))
          .join(""),
    );
    this.menu.setAttribute("role", "toolbar");
    localizeAttribute(this.menu, "aria-label", "documents.selectionFormatting", undefined, t);
    documentOverlayHost(editor.view.dom).append(this.menu);
    const signal = this.listeners.signal;
    document.addEventListener("selectionchange", this.schedule, { signal });
    document.addEventListener("scroll", this.schedule, { capture: true, passive: true, signal });
    window.addEventListener("resize", this.schedule, { signal });
    this.desktop.addEventListener("change", this.schedule, { signal });
    this.editor.on("transaction", this.schedule);
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (this.menu.contains(event.target as Node)) return;
        this.dragging = this.editor.view.dom.contains(event.target as Node);
        if (this.dragging) this.dismissed = "";
        this.menu.hidden = true;
      },
      { signal },
    );
    document.addEventListener(
      "pointerup",
      () => {
        this.dragging = false;
        this.schedule();
      },
      { signal },
    );
    this.menu.addEventListener(
      "mousedown",
      (event) => {
        if ((event.target as Element).closest("button")) event.preventDefault();
      },
      { signal },
    );
    this.menu.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-selection-action]");
        if (button) void this.command(button.dataset.selectionAction!).catch(this.error);
      },
      { signal },
    );
    this.menu
      .querySelector<HTMLSelectElement>("select")!
      .addEventListener("change", (event) => this.heading(Number((event.target as HTMLSelectElement).value)), {
        signal,
      });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !this.menu.hidden) {
          event.preventDefault();
          const focused = this.menu.contains(document.activeElement);
          this.dismissed = this.key();
          this.menu.hidden = true;
          if (focused) this.editor.commands.focus();
        }
        if (event.altKey && event.key === "F10" && this.editor.isFocused) {
          this.dismissed = "";
          this.update();
          if (!this.menu.hidden) {
            event.preventDefault();
            this.menu.querySelector<HTMLElement>("select,button")?.focus();
          }
        }
      },
      { signal },
    );
  }
  private key() {
    const { from, to } = this.editor.state.selection;
    return `${from}:${to}`;
  }
  private update() {
    if (this.editor.isDestroyed) return;
    const selection = window.getSelection(),
      focused = this.menu.contains(document.activeElement);
    if (
      !this.desktop.matches ||
      !this.editor.isEditable ||
      !(this.editor.state.selection instanceof TextSelection) ||
      (!this.editor.isFocused && !focused) ||
      this.dragging ||
      this.editor.state.selection.empty ||
      this.key() === this.dismissed
    ) {
      this.menu.hidden = true;
      return;
    }
    if (
      !focused &&
      (!selection?.rangeCount ||
        !this.editor.view.dom.contains(selection.anchorNode) ||
        !this.editor.view.dom.contains(selection.focusNode) ||
        !selection.toString().trim())
    ) {
      this.menu.hidden = true;
      return;
    }
    for (const button of this.menu.querySelectorAll<HTMLButtonElement>("[data-selection-action]"))
      button.setAttribute("aria-pressed", String(this.editor.isActive(button.dataset.selectionAction!)));
    const heading = this.menu.querySelector<HTMLSelectElement>("select")!;
    if (document.activeElement !== heading) heading.value = String(this.editor.getAttributes("heading").level || 0);
    if (focused) return;
    const canvas = this.editor.view.dom.closest(".document-canvas") ?? this.editor.view.dom,
      bounds = canvas.getBoundingClientRect(),
      rects = [...selection!.getRangeAt(0).getClientRects()].filter(
        (rect) => rect.height && rect.bottom > bounds.top && rect.top < bounds.bottom,
      ),
      anchor = rects.at(-1);
    if (!anchor) {
      this.menu.hidden = true;
      return;
    }
    placeDocumentPopover(this.menu, anchor, bounds, true);
  }
  close() {
    cancelAnimationFrame(this.frame);
    this.listeners.abort();
    this.editor.off("transaction", this.schedule);
    this.menu.remove();
  }
  hide() {
    this.menu.hidden = true;
  }
}
