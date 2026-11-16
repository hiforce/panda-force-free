import {
  GadgetError,
  GADGET_LIMITS,
  type GadgetLayout,
  type GadgetManifest,
  type GadgetInstance,
  type GadgetConfig,
} from "./contracts.js";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
export function validateGadgetConfig(value: unknown, manifest: GadgetManifest): GadgetConfig {
  if (!record(value) || Object.keys(value).some((k) => !Object.hasOwn(manifest.config, k)))
    throw new GadgetError("invalidInput");
  const config: GadgetConfig = {};
  for (const [key, field] of Object.entries(manifest.config)) {
    const v = Object.hasOwn(value, key) ? value[key] : field.default;
    if (
      typeof v !== field.type ||
      (typeof v === "string" && v.length > (field.max ?? 200)) ||
      (typeof v === "number" && (!Number.isFinite(v) || v < (field.min ?? 0) || v > (field.max ?? 20)))
    )
      throw new GadgetError("invalidInput");
    config[key] = v as GadgetConfig[string];
  }
  return config;
}
export function defaultGadgetLayout(manifests: readonly GadgetManifest[]): GadgetLayout {
  const defaults = manifests
    .filter((m) => m.defaultPlacement)
    .toSorted((a, b) => a.defaultPlacement!.order - b.defaultPlacement!.order);
  const items = defaults.map((m) => ({
    id: m.id,
    gadget: m.id,
    configVersion: m.configVersion,
    config: validateGadgetConfig({}, m),
    title: "",
    w: m.layout.w,
    h: m.layout.h,
    x: m.defaultPlacement!.x,
    y: m.defaultPlacement!.y,
    visible: { desktop: true, mobile: true },
  }));
  settleGadgetLayout(items);
  return { version: 1, revision: 0, preset: "primary", density: "compact", items, mobileOrder: items.map((i) => i.id) };
}
export function collides(
  a: Pick<GadgetInstance, "x" | "y" | "w" | "h">,
  b: Pick<GadgetInstance, "x" | "y" | "w" | "h">,
) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
export function settleGadgetLayout(items: GadgetInstance[], first?: GadgetInstance) {
  const placed: GadgetInstance[] = [];
  for (const i of [
    ...(first ? [first] : []),
    ...items.filter((i) => i !== first).toSorted((a, b) => a.y - b.y || a.x - b.x),
  ]) {
    i.x = Math.min(12 - i.w, Math.max(0, i.x));
    let collision;
    while ((collision = placed.find((p) => collides(i, p)))) i.y = collision.y + collision.h;
    placed.push(i);
  }
}
export function validateGadgetLayout(
  value: unknown,
  manifests: readonly GadgetManifest[],
  prior?: GadgetLayout,
): GadgetLayout {
  if (
    !record(value) ||
    JSON.stringify(value).length > GADGET_LIMITS.bytes ||
    value.version !== 1 ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !["compact", "comfortable"].includes(String(value.density)) ||
    !["primary", "equal", "full"].includes(String(value.preset)) ||
    !Array.isArray(value.items) ||
    value.items.length > GADGET_LIMITS.instances ||
    !Array.isArray(value.mobileOrder)
  )
    throw new GadgetError("invalidInput");
  const ids = new Set<string>(),
    singletons = new Set<string>();
  const items = value.items.map((item): GadgetInstance => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !/^[-a-zA-Z0-9._:]{1,120}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.gadget !== "string" ||
      !/^[-a-zA-Z0-9._:]{1,120}$/.test(item.gadget) ||
      typeof item.title !== "string" ||
      item.title.length > 80 ||
      !record(item.visible) ||
      typeof item.visible.desktop !== "boolean" ||
      typeof item.visible.mobile !== "boolean" ||
      !integer(item.x, 0, 11) ||
      !integer(item.y, 0, 4096) ||
      !integer(item.w, 1, 12) ||
      item.x + item.w > 12 ||
      !integer(item.h, 4, 24) ||
      !integer(item.configVersion, 1, 10000) ||
      !record(item.config)
    )
      throw new GadgetError("invalidInput");
    ids.add(item.id);
    const manifest = manifests.find((m) => m.id === item.gadget),
      old = prior?.items.find((i) => i.id === item.id && i.gadget === item.gadget);
    if (!manifest && !old) throw new GadgetError("missing", 404);
    if (manifest && (item.w < manifest.layout.minW || item.h < manifest.layout.minH))
      throw new GadgetError("invalidInput");
    if (manifest?.singleton && singletons.has(manifest.id)) throw new GadgetError("invalidInput");
    if (manifest) singletons.add(manifest.id);
    // An unavailable version keeps its opaque configuration; callers cannot manufacture new unknown instances.
    const compatible = manifest && item.configVersion === manifest.configVersion;
    if (!compatible && (!old || JSON.stringify(item.config) !== JSON.stringify(old.config)))
      throw new GadgetError("incompatible", 409);
    return {
      id: item.id,
      gadget: item.gadget,
      title: item.title,
      configVersion: item.configVersion,
      config: compatible ? validateGadgetConfig(item.config, manifest) : structuredClone(old!.config),
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      visible: { desktop: item.visible.desktop, mobile: item.visible.mobile },
    };
  });
  if (
    value.mobileOrder.length !== ids.size ||
    new Set(value.mobileOrder).size !== ids.size ||
    value.mobileOrder.some((id) => typeof id !== "string" || !ids.has(id)) ||
    items.some((a, n) => items.slice(n + 1).some((b) => collides(a, b)))
  )
    throw new GadgetError("invalidInput");
  return {
    version: 1,
    revision: value.revision,
    density: value.density as GadgetLayout["density"],
    preset: value.preset as GadgetLayout["preset"],
    items,
    mobileOrder: value.mobileOrder as string[],
  };
}
