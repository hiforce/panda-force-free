import { localizeText } from "./i18n.js";

/** @type {(() => void) | null} */
let cancelActiveConfirmation = null;
let confirmationSequence = 0;

// Confirmation state belongs to this dialog, separate from application data.
/** @param {{title: string; message: string; values?: Record<string, unknown>; confirmText?: string; cancelText?: string; returnFocus?: Element | (() => Element | null) | null}} options */
export function confirmAction({
  title,
  message,
  confirmText,
  cancelText,
  values,
  returnFocus = document.activeElement,
}) {
  cancelActiveConfirmation?.();
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "workbench-dialog confirmation-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const id = `confirmation-${++confirmationSequence}`;
    dialog.setAttribute("aria-labelledby", id + "-title");
    dialog.setAttribute("aria-describedby", id + "-message");
    const brand = document.createElement("span");
    brand.className = "confirmation-brand";
    localizeText(brand, "common.pandaforce", undefined);
    const heading = document.createElement("h2");
    heading.id = id + "-title";
    localizeText(heading, title, values);
    const description = document.createElement("p");
    description.id = id + "-message";
    localizeText(description, message, values);
    const form = document.createElement("form");
    form.className = "confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "submit";
    cancel.className = "wb-button";
    localizeText(cancel, cancelText, values);
    cancel.autofocus = true;
    const accept = document.createElement("button");
    accept.type = "submit";
    accept.className = "wb-button danger";
    localizeText(accept, confirmText, values);
    form.append(cancel, accept);
    dialog.append(brand, heading, description, form);
    let settled = false;
    function finish(accepted = false) {
      if (settled) return;
      settled = true;
      if (cancelActiveConfirmation === dismiss) cancelActiveConfirmation = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      // Background rendering may replace the original trigger before dismissal.
      const focusTarget = typeof returnFocus === "function" ? returnFocus() : returnFocus;
      if (focusTarget instanceof HTMLElement && focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
      resolve(accepted);
    }
    const dismiss = () => finish(false);
    cancelActiveConfirmation = dismiss;
    form.onsubmit = (event) => {
      event.preventDefault();
      finish(event.submitter === accept);
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener("close", dismiss);
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    dialog.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dismiss();
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
