import type { GadgetLayout, GadgetManifest } from "../../shared/gadget/contracts.js";
import { defaultGadgetLayout } from "../../shared/gadget/layout.js";

/** Upgrade the previous untouched preset; custom layouts keep every existing placement and setting. */
export function upgradeSystemGadgetLayout(layout: GadgetLayout, catalog: readonly GadgetManifest[]): GadgetLayout {
  if ((layout.catalogVersion ?? 0) >= 1) return layout;
  const result = structuredClone(layout);
  result.catalogVersion = 1;
  if (result.items.some((item) => item.gadget === "system.creations") || !result.items.length) return result;
  const previous = [
    ["system.composer", 0, 0, 8, 11],
    ["system.recent", 0, 11, 8, 12],
    ["system.projects", 8, 0, 4, 7],
    ["system.skills", 8, 7, 4, 6],
  ] as const;
  const unchanged =
    result.items.length === previous.length &&
    previous.every(([id, x, y, w, h]) => {
      const item = result.items.find((item) => item.id === id && item.gadget === id);
      return (
        item &&
        item.x === x &&
        item.y === y &&
        item.w === w &&
        item.h === h &&
        !item.title &&
        item.visible.desktop &&
        item.visible.mobile &&
        JSON.stringify(item.config) ===
          JSON.stringify(defaultGadgetLayout(catalog).items.find((entry) => entry.gadget === id)?.config)
      );
    });
  if (
    unchanged &&
    JSON.stringify(result.mobileOrder) === JSON.stringify(previous.map(([id]) => id)) &&
    result.density === "compact" &&
    result.preset === "primary"
  )
    return { ...defaultGadgetLayout(catalog), revision: result.revision };
  const addition = defaultGadgetLayout(catalog).items.find((item) => item.gadget === "system.creations");
  if (!addition || result.items.length >= 24) return result;
  addition.y = Math.max(...result.items.map((item) => item.y + item.h));
  if (addition.y > 4096) return result;
  result.items.push(addition);
  const composer = result.mobileOrder.findIndex(
    (id) => result.items.find((item) => item.id === id)?.gadget === "system.composer",
  );
  result.mobileOrder.splice(composer >= 0 ? composer + 1 : result.mobileOrder.length, 0, addition.id);
  return result;
}
