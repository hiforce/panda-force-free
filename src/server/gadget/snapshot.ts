import { GadgetError, type GadgetLayout, GADGET_LIMITS } from "../../shared/gadget/contracts.js";
export function emptyGadgetLayout(): GadgetLayout {
  return { version: 1, revision: 0, density: "compact", preset: "primary", items: [], mobileOrder: [] };
}
export function storedLayout(data: string): GadgetLayout {
  try {
    const value = JSON.parse(data) as GadgetLayout;
    if (
      data.length > GADGET_LIMITS.bytes ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      !Array.isArray(value.items) ||
      value.items.length > 24 ||
      !Array.isArray(value.mobileOrder)
    )
      throw Error();
    return value;
  } catch {
    throw new GadgetError("unavailable", 503);
  }
}
