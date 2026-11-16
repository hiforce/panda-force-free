import { setMessageHtml } from "../i18n.js";
import { botUi, type BotContext } from "./ui.js";
import type { MessageId } from "../../shared/i18n/messages.js";
const pendingFocus = new WeakMap<HTMLDialogElement, HTMLElement>();

/** Native dialogs own focus trapping; closing removes all draft or secret DOM. */
export function botDialog(
  host: HTMLElement,
  context: BotContext,
  title: MessageId,
  hint: MessageId | null,
  body: string,
  restoreFocus?: HTMLElement,
) {
  const { h, button } = botUi(context.t),
    previous = restoreFocus ?? document.activeElement,
    dialog = document.createElement("dialog");
  dialog.className = "bot-dialog wb-form";
  dialog.setAttribute("aria-labelledby", "botDialogTitle");
  setMessageHtml(
    dialog,
    `<header class="bot-dialog-heading"><div><h2 id="botDialogTitle">${h(title)}</h2>${hint ? `<p>${h(hint)}</p>` : ""}</div>${button("common.close", "data-close", false, "x")}<div class="bot-dialog-notice" role="status" aria-live="polite" data-bot-dialog-notice></div></header><div class="bot-dialog-body">${body}</div>`,
  );
  host.append(dialog);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  dialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => dialog.close();
  dialog.oncancel = (event) => {
    if (dialog.dataset.pending === "true") event.preventDefault();
  };
  dialog.addEventListener("close", () => {
    dialog.remove();
    queueMicrotask(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      else {
        const marker =
          previous instanceof HTMLElement
            ? Object.entries(previous.dataset).find(([key]) => ["edit", "newBot", "issueKey", "detail"].includes(key))
            : null;
        const target = marker
          ? host.querySelector<HTMLElement>(
              `[data-${marker[0].replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${CSS.escape(marker[1] ?? "")}"]`,
            )
          : null;
        const fallback = target ?? host.querySelector<HTMLElement>("h1");
        if (fallback) {
          if (!target) fallback.tabIndex = -1;
          fallback.focus({ preventScroll: true });
        }
      }
    });
  });
  dialog.showModal();
  return dialog;
}
export function dialogPending(dialog: HTMLDialogElement, pending: boolean) {
  if (pending && dialog.contains(document.activeElement)) {
    pendingFocus.set(dialog, document.activeElement as HTMLElement);
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }
  dialog.dataset.pending = String(pending);
  dialog.setAttribute("aria-busy", String(pending));
  dialog
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      "input, textarea, select, button",
    )
    .forEach((button) => {
      if (pending) button.dataset.wasDisabled = String(button.disabled);
      button.disabled = pending || button.dataset.wasDisabled === "true";
    });
  if (!pending && dialog.open && document.activeElement === dialog) {
    const previous = pendingFocus.get(dialog);
    const next = previous?.isConnected ? previous : dialog.querySelector<HTMLInputElement>("[data-key]");
    next?.focus({ preventScroll: true });
    pendingFocus.delete(dialog);
  }
}
