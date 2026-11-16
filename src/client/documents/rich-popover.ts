/** Transient editor controls share the editor's modal layer and remain reachable by pointer and keyboard. */
export function documentOverlayHost(anchor: HTMLElement): HTMLElement {
  return anchor.closest("dialog") || anchor.ownerDocument.body;
}

/** Popovers stay in the document viewport and never change the page's scroll position. */
export function placeDocumentPopover(menu: HTMLElement, anchor: DOMRect, bounds: DOMRect, above = false) {
  const top = Math.max(8, bounds.top),
    bottom = Math.min(window.innerHeight - 8, bounds.bottom),
    left = Math.max(8, bounds.left),
    right = Math.min(window.innerWidth - 8, bounds.right);
  menu.style.maxWidth = Math.max(120, right - left - 16) + "px";
  menu.style.maxHeight = Math.max(100, bottom - top - 16) + "px";
  menu.hidden = false;
  const size = menu.getBoundingClientRect(),
    x = Math.max(left + 8, Math.min(anchor.left + (anchor.width - size.width) / 2, right - size.width - 8)),
    preferred = above && anchor.top - size.height - 8 >= top ? anchor.top - size.height - 8 : anchor.bottom + 8;
  menu.style.left = x + "px";
  menu.style.top = Math.max(top + 4, Math.min(preferred, bottom - size.height - 4)) + "px";
}
