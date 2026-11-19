import { findElement } from "../dom.js";

/** @type {WeakMap<HTMLElement, () => void>} */
const overlays = new WeakMap();

/** Shared visible bounds keep composer panels above navigation and the on-screen keyboard. */
export function composerPanelBounds() {
  const viewport = window.visualViewport,
    left = viewport?.offsetLeft || 0,
    top = viewport?.offsetTop || 0,
    width = viewport?.width || innerWidth,
    height = viewport?.height || innerHeight;
  let bottom = top + height - 8;
  for (const selector of [".workspace-attribution", ".workbench-mobile-nav"]) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.height && bounds.top >= top && bounds.top < top + height) bottom = Math.min(bottom, bounds.top - 8);
  }
  return { left, top, width, height, bottom };
}

/** @param {HTMLElement} panel */
export function syncComposerPanelViewport(panel) {
  const { top, bottom } = composerPanelBounds();
  panel.style.setProperty("--composer-panel-bottom", `${Math.max(0, innerHeight - bottom)}px`);
  panel.style.setProperty("--composer-panel-height", `${Math.max(0, bottom - top - 8)}px`);
}

/** @param {HTMLElement} menu */
export function restoreSessionMenu(menu) {
  overlays.get(menu)?.();
}

/** Keep composer menus outside clipped reading columns and below modal confirmation dialogs.
 * @param {HTMLElement} menu @param {HTMLButtonElement} trigger @param {() => void} close
 */
export function mountSessionMenu(menu, trigger, close) {
  restoreSessionMenu(menu);
  const placeholder = document.createComment("session menu"),
    parent = menu.parentElement;
  menu.before(placeholder);
  (trigger.closest("dialog[open]") || document.body).append(menu);
  const preferredWidth = parseFloat(getComputedStyle(menu).width) || 310;
  menu.classList.add("session-menu-overlay");
  let frame = 0;
  const position = () => {
    frame = 0;
    if (!trigger.isConnected || trigger.closest("[hidden], [inert]") || !trigger.getClientRects().length) {
      close();
      return;
    }
    const { left, top, width, bottom } = composerPanelBounds(),
      mobile = matchMedia("(max-width: 767px)").matches;
    const menuWidth = Math.max(0, Math.min(mobile ? 480 : preferredWidth, width - 16));
    menu.style.width = `${menuWidth}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(420, bottom - top - 8))}px`;
    const bounds = menu.getBoundingClientRect(),
      anchor = trigger.getBoundingClientRect();
    const above = anchor.top - bounds.height - 6;
    const y = mobile ? bottom - bounds.height : above >= top + 8 ? above : anchor.bottom + 6;
    menu.style.left = `${mobile ? left + (width - menuWidth) / 2 : Math.max(left + 8, Math.min(anchor.left, left + width - menuWidth - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, bottom - bounds.height))}px`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(position);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(menu);
  for (const element of document.querySelectorAll(".workspace-attribution, .workbench-mobile-nav"))
    observer.observe(element);
  const page = document.body.dataset.workbenchPage;
  const lifecycle = new MutationObserver(() => {
    if (document.body.dataset.workbenchPage !== page) close();
    else schedule();
  });
  lifecycle.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "data-workbench-page"],
  });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  overlays.set(menu, () => {
    overlays.delete(menu);
    observer.disconnect();
    lifecycle.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    menu.classList.remove("session-menu-overlay");
    for (const property of ["left", "top", "width", "max-height"]) menu.style.removeProperty(property);
    if (placeholder.parentNode) placeholder.replaceWith(menu);
    else parent?.append(menu);
  });
  position();
}

/** @param {HTMLElement} menu */
export function focusMenuSelection(menu) {
  const close = findElement(".session-menu-close", menu);
  const selected =
    findElement('input[type="range"]:not(:disabled)', menu) ||
    findElement('[aria-checked="true"]:not(:disabled)', menu) ||
    findElement("button:not(.session-menu-close):not(:disabled)", menu) ||
    close;
  if (selected?.getClientRects().length) selected.focus({ preventScroll: true });
}
/** @param {HTMLElement} menu @param {HTMLButtonElement | (() => HTMLButtonElement)} trigger @param {() => void} close */
export function bindMenuDismiss(menu, trigger, close) {
  const dismiss = () => {
    close();
    (typeof trigger === "function" ? trigger() : trigger).focus({ preventScroll: true });
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
