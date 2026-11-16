import type { Translate } from "../../../shared/i18n/messages.js";
import { setMessageHtml, messageHtml } from "../../i18n.js";

export type TreeMenuAction = "new-child" | "new-child-template" | "rename" | "move" | "trash";
/** A bounded anchored menu owns outside-click, keyboard and scrolling cleanup. */
export class DocumentTreeMenu {
  private element: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private anchor: HTMLElement | null = null;
  constructor(private t: Translate) {}
  close(restore = false) {
    const anchor = this.anchor;
    this.anchor = null;
    this.listeners?.abort();
    this.listeners = null;
    this.element?.remove();
    this.element = null;
    if (restore && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }
  open(anchor: HTMLElement, action: (kind: TreeMenuAction) => void, canEdit: boolean, templates = false) {
    this.close();
    const menu = document.createElement("div");
    menu.className = "document-tree-menu";
    menu.setAttribute("role", "menu");
    this.anchor = anchor;
    setMessageHtml(
      menu,
      (
        [
          ["new-child", "documents.newChild"],
          ...(templates ? [["new-child-template", "templates.createDocumentFromTemplate"] as const] : []),
          ["rename", "documents.renameNode"],
          ["move", "documents.moveDocument"],
          ["trash", "documents.deleteDocument"],
        ] as const
      )
        .map(
          ([kind, key]) =>
            `<button type="button" role="menuitem" data-node-command="${kind}" ${!canEdit && ["rename", "trash"].includes(kind) ? "disabled" : ""} class="${kind === "trash" ? "danger" : ""}">${messageHtml(key, undefined, this.t)}</button>`,
        )
        .join(""),
    );
    document.body.append(menu);
    this.element = menu;
    const box = anchor.getBoundingClientRect(),
      width = menu.offsetWidth,
      height = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(innerWidth - width - 8, box.right - width)) + "px";
    menu.style.top = Math.max(8, Math.min(innerHeight - height - 8, box.bottom + 6)) + "px";
    const listeners = new AbortController();
    this.listeners = listeners;
    const { signal } = listeners;
    menu.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-node-command]");
        if (!button || button.disabled) return;
        const kind = button.dataset.nodeCommand as TreeMenuAction;
        this.close();
        action(kind);
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) this.close();
      },
      { signal, capture: true },
    );
    window.addEventListener("scroll", () => this.close(), { signal, capture: true });
    menu.addEventListener(
      "keydown",
      (event) => {
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          this.close(true);
        }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      },
      { signal },
    );
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }
}
