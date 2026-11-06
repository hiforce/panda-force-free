import { closestElement, findElements } from "./dom.js";
import { createLifecycle } from "./lifecycle.js";
// Put menus outside scrolling/clipped cards while retaining their original event handlers.
export function createAnchoredMenu({ onClose = () => {} } = {}) {
  const lifecycle = createLifecycle();
  let active = null;
  const close = (restoreFocus = false) => {
    if (!active) return;
    const { trigger, menu, placeholder } = active;
    active = null;
    menu.hidden = true;
    menu.classList.remove("floating-menu");
    menu.style.removeProperty("left");
    menu.style.removeProperty("top");
    menu.style.removeProperty("width");
    menu.style.removeProperty("max-height");
    if (placeholder.isConnected) placeholder.replaceWith(menu);
    else menu.remove();
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger.isConnected) trigger.focus();
    onClose();
  };
  const position = () => {
    if (!active) return;
    const { trigger, menu } = active;
    if (!trigger.isConnected) {
      close();
      return;
    }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0,
      top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth,
      height = viewport?.height || innerHeight;
    const anchor = trigger.getBoundingClientRect();
    active.anchor = anchor;
    menu.style.width = `${Math.max(0, Math.min(240, width - 16))}px`;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const rect = menu.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const y = below + rect.height <= top + height - 8 ? below : anchor.top - rect.height - 6;
    menu.style.left = `${Math.max(left + 8, Math.min(anchor.right - rect.width, left + width - rect.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - rect.height - 8))}px`;
  };
  const toggle = (trigger, menu) => {
    const wasOpen = active?.menu === menu;
    close();
    if (wasOpen) {
      trigger.focus();
      return;
    }
    const placeholder = document.createComment("menu");
    menu.before(placeholder);
    // A modal makes the rest of the document inert. Keep its menu in the
    // same top layer so its choices remain visible and clickable.
    (closestElement("dialog[open]", trigger) || document.body).append(menu);
    menu.hidden = false;
    menu.classList.add("floating-menu");
    menu.setAttribute("role", "menu");
    const items = [...findElements("button", menu)];
    for (const item of items) item.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "true");
    active = { trigger, menu, placeholder, anchor: null };
    position();
    items[0]?.focus({ preventScroll: true });
  };
  // List projections can replace a trigger while its menu is being used.
  const reanchor = (trigger) => {
    if (!active) return;
    if (!trigger?.isConnected || closestElement("[inert]", trigger)) {
      close();
      return;
    }
    active.trigger.setAttribute("aria-expanded", "false");
    active.trigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    position();
  };
  lifecycle.on(document, "click", (event) => {
    if (active && !event.composedPath().includes(active.menu) && !event.composedPath().includes(active.trigger))
      close();
  });
  lifecycle.on(document, "keydown", (event) => {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(true);
    else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && active.menu.contains(event.target)) {
      event.preventDefault();
      const items = [...findElements("button:not(:disabled)", active.menu)];
      const index = items.findIndex((item) => item === document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  lifecycle.on(
    document,
    "scroll",
    (event) => {
      if (!active || active.menu.contains(event.target)) return;
      if (event.target instanceof Element && event.target.contains(active.trigger)) {
        const anchor = active.trigger.getBoundingClientRect();
        // Focus can scroll the trigger before opening, with its event delivered afterwards.
        if (active.anchor && ["left", "top", "right", "bottom"].every((edge) => anchor[edge] === active.anchor[edge]))
          return;
      }
      close();
    },
    true,
  );
  lifecycle.on(window, "resize", position);
  if (window.visualViewport) lifecycle.on(window.visualViewport, "resize", position);
  if (window.visualViewport) lifecycle.on(window.visualViewport, "scroll", position);
  return {
    dispose() {
      close();
      lifecycle.dispose();
    },
    toggle,
    reanchor,
    close,
    closeFor: (container) => {
      if (active && container?.contains(active.trigger)) close();
    },
  };
}
