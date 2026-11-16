import { findElement } from "../dom.js";

/** @param {HTMLElement} menu */
export function focusMenuSelection(menu) {
  const close = findElement(".session-menu-close", menu);
  if (!close?.getClientRects().length) return;
  (findElement('[aria-checked="true"]', menu) || findElement("button:not(.session-menu-close)", menu) || close).focus({
    preventScroll: true,
  });
}
/** @param {HTMLElement} menu @param {HTMLButtonElement} trigger @param {() => void} close */
export function bindMenuDismiss(menu, trigger, close) {
  const dismiss = () => {
    close();
    trigger.focus({ preventScroll: true });
  };
  menu.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".session-menu-close")) dismiss();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
}
