function selectable(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && ["text", "search", "tel", "url", "password"].includes(element.type))
  );
}

/** Capture only focus owned by this view; unsupported controls never enter text-selection APIs. */
export function captureRenderFocus(root: HTMLElement) {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !root.contains(element) || !element.id) return null;
  return {
    element,
    id: element.id,
    selection: selectable(element)
      ? {
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        }
      : null,
  };
}
export function restoreRenderFocus(root: HTMLElement, snapshot: ReturnType<typeof captureRenderFocus>) {
  if (!snapshot) return;
  const next = root.querySelector<HTMLElement>("#" + CSS.escape(snapshot.id));
  if (!next || next === snapshot.element) return;
  next.focus({ preventScroll: true });
  if (selectable(next) && snapshot.selection?.start !== null && snapshot.selection?.start !== undefined)
    next.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction ?? undefined);
}
