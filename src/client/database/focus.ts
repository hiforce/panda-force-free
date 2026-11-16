const actions = ["refresh", "test", "review", "migrate", "edit", "recover", "retry", "cancel", "done"] as const;
export interface DatabaseFocus {
  selector: string;
  selection: number | null;
}
export function captureDatabaseFocus(root: HTMLElement): DatabaseFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  const field = active.dataset.databaseField;
  if (field)
    return {
      selector: `[data-database-field="${field}"]`,
      selection: active instanceof HTMLInputElement ? active.selectionStart : null,
    };
  const action = actions.find((name) => active.hasAttribute("data-database-" + name));
  if (action) return { selector: "[data-database-" + action + "]", selection: null };
  if (active.hasAttribute("data-database-title")) return { selector: "[data-database-title]", selection: null };
  if (active.id === "database-plan-title") return { selector: "#database-plan-title", selection: null };
  if (active.hasAttribute("data-database-operation-title"))
    return { selector: "[data-database-operation-title]", selection: null };
  return null;
}
export function restoreDatabaseFocus(root: HTMLElement, focus: DatabaseFocus | null) {
  if (!focus) return;
  const target =
    root.querySelector<HTMLElement>(focus.selector) ??
    root.querySelector<HTMLElement>("[data-database-operation-title]");
  if (!target || ("disabled" in target && target.disabled)) return;
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement && focus.selection !== null && target.type !== "number")
    target.setSelectionRange(focus.selection, focus.selection);
}
