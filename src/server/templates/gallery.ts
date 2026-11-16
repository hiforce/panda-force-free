import { templateLineageKey, type ManagedTemplate } from "../../shared/templates/catalog.js";

/** Gallery entries identify a skill; immutable historical releases stay in the version view. */
export function galleryTemplates(items: readonly ManagedTemplate[], removed: boolean): ManagedTemplate[] {
  const selected = new Map<string, ManagedTemplate>();
  for (const item of items) {
    if (item.state.removed !== removed) continue;
    const key = templateLineageKey(item.reference),
      previous = selected.get(key);
    if (
      !previous ||
      (item.state.active && !previous.state.active) ||
      (item.state.active === previous.state.active &&
        item.reference.version.localeCompare(previous.reference.version, "en", { numeric: true }) > 0)
    )
      selected.set(key, item);
  }
  return [...selected.values()];
}
