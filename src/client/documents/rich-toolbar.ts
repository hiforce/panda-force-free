import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { setMessageHtml, messageHtml as m, messageAttributes as attrs } from "../i18n.js";
import { richActions, richActionButton, richHeadingSelect } from "./rich-actions.js";
import { codexIcon } from "../codex-icons.js";
import { DocumentToolbarDock } from "./toolbar-dock.js";
import { escapeHtml as e } from "../../shared/html.js";

interface ToolbarActions {
  command(name: string): Promise<void>;
  heading(level: number): void;
  block(anchor: HTMLElement): void;
  insert(anchor: HTMLElement): void;
  error(error: unknown): void;
}

/** The persistent toolbar owns controls and transient menu lifetime, never the document model. */
export class DocumentRichToolbar {
  readonly element = document.createElement("div");
  private listeners = new AbortController();
  private more: HTMLDetailsElement;
  private dock: DocumentToolbarDock | null;
  constructor(host: HTMLElement, t: Translate, actions: ToolbarActions, docked = false) {
    this.element.className = "document-rich-toolbar";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", t("documents.richEditorLabel"));
    const button = (name: string, key: MessageId, label: string) =>
      `<button type="button" class="document-format-button" data-rich-action="${name}" ${attrs("aria-label", key, undefined, t)} ${attrs("title", key, undefined, t)}>${label}</button>`;
    setMessageHtml(
      this.element,
      `${richHeadingSelect(t)}${richActions.map(({ id }) => richActionButton(t, id)).join("")}<details class="document-format-more"><summary aria-label="${e(t("documents.formatMore"))}" title="${e(t("documents.formatMore"))}">⋯</summary><div>${[
        ["code", "documents.formatCode"],
        ["left", "documents.alignLeft"],
        ["center", "documents.alignCenter"],
        ["right", "documents.alignRight"],
        ["horizontalRule", "documents.formatRule"],
        ["row", "documents.addTableRow"],
        ["column", "documents.addTableColumn"],
        ["removeRow", "documents.deleteTableRow"],
        ["removeColumn", "documents.deleteTableColumn"],
        ["removeTable", "documents.deleteTable"],
      ]
        .map(([name, key]) => button(name!, key as MessageId, m(key as MessageId, undefined, t)))
        .join(
          "",
        )}</div></details><button type="button" class="document-format-button" data-rich-block-toggle ${attrs("aria-label", "documents.blockActions", undefined, t)} ${attrs("title", "documents.blockActions", undefined, t)} aria-haspopup="menu">${codexIcon("gripVertical")}</button><button type="button" class="document-format-button" data-rich-insert-toggle ${attrs("aria-label", "documents.insertContent", undefined, t)} ${attrs("title", "documents.insertContent", undefined, t)} aria-haspopup="menu" aria-expanded="false">${codexIcon("plus")}</button>${button("undo", "documents.formatUndo", "↶")}${button("redo", "documents.formatRedo", "↷")}`,
    );
    host.prepend(this.element);
    this.dock = docked ? new DocumentToolbarDock(host) : null;
    this.more = this.element.querySelector<HTMLDetailsElement>("details")!;
    const signal = this.listeners.signal;
    this.element.addEventListener(
      "mousedown",
      (event) => {
        if ((event.target as Element).closest("button, .document-format-more > summary")) event.preventDefault();
      },
      { signal },
    );
    this.element.addEventListener(
      "click",
      (event) => {
        const target = event.target as Element;
        if (target.closest(".document-format-more > summary")) {
          event.preventDefault();
          this.more.open = !this.more.open;
          this.positionMore();
          return;
        }
        const button = target.closest<HTMLButtonElement>("button");
        if (!button || button.disabled) return;
        if (button.hasAttribute("data-rich-block-toggle")) actions.block(button);
        else if (button.hasAttribute("data-rich-insert-toggle")) actions.insert(button);
        else if (button.dataset.richAction) {
          this.more.open = false;
          void actions.command(button.dataset.richAction).catch(actions.error);
        }
      },
      { signal },
    );
    this.element.querySelector<HTMLSelectElement>("[data-rich-heading]")!.addEventListener(
      "change",
      (event) => {
        actions.heading(Number((event.target as HTMLSelectElement).value));
      },
      { signal },
    );
    this.more.addEventListener(
      "toggle",
      () => {
        this.positionMore();
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.more.contains(event.target as Node)) this.more.open = false;
      },
      { signal },
    );
    this.element.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") this.more.open = false;
      },
      { signal },
    );
    document.addEventListener(
      "scroll",
      (event) => {
        // Opening a menu may scroll its toolbar horizontally; retain and reposition it.
        if (event.target === this.element) {
          this.positionMore();
          return;
        }
        if (event.target instanceof Node && this.more.contains(event.target)) return;
        this.more.open = false;
      },
      { signal, capture: true },
    );
    window.addEventListener(
      "resize",
      () => {
        this.more.open = false;
      },
      { signal },
    );
  }
  private positionMore() {
    if (!this.more.open) return;
    const trigger = this.more.querySelector("summary")!.getBoundingClientRect(),
      menu = this.more.querySelector<HTMLElement>("div")!;
    menu.style.left = Math.max(8, Math.min(trigger.left, window.innerWidth - 240)) + "px";
    menu.style.top =
      Math.max(8, Math.min(trigger.bottom + 6, window.innerHeight - Math.min(menu.scrollHeight, 360) - 12)) + "px";
  }
  update(editable: boolean, heading: number, active: (name: string) => boolean) {
    for (const button of this.element.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = !editable;
      const name = button.dataset.richAction;
      if (name && richActions.some((action) => action.id === name && !["image", "table"].includes(action.id)))
        button.setAttribute("aria-pressed", String(active(name)));
    }
    const select = this.element.querySelector<HTMLSelectElement>("[data-rich-heading]")!;
    select.disabled = !editable;
    if (document.activeElement !== select) select.value = String(heading);
    this.element.hidden = !editable;
    this.dock?.setVisible(editable);
    if (!editable) this.more.open = false;
  }
  close() {
    this.listeners.abort();
    this.dock?.close();
    this.element.remove();
  }
}
