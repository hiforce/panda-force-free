import { builtinSkillCategories, isSkillCategory, type SkillWorkspaceSnapshot } from "../../shared/skill-workspace.js";
import { isPublishingTemplate } from "../../shared/templates/domain.js";
import type { TemplateCatalog } from "../templates/catalog.js";

/** Read legacy preferences without rewriting stored rows or idempotency receipts. */
export async function skillWorkspaceProjection(
  stored: SkillWorkspaceSnapshot,
  catalog: TemplateCatalog,
  owner: string,
): Promise<SkillWorkspaceSnapshot> {
  const categories = stored.categories.filter(isSkillCategory).map((category) => {
      const seed = builtinSkillCategories.find((value) => value.id === category.id);
      return seed && category.name.en === seed.name.en && category.name["zh-CN"] === seed.name["zh-CN"]
        ? { ...category, name: { ...seed.name, ...category.name } }
        : category;
    }),
    allowed = new Set(categories.map((category) => category.id)),
    portablePins = stored.pins.flatMap((pin) =>
      pin.kind === "skill" && pin.key.startsWith("portable:") ? [pin.key] : [],
    ),
    legacyBuiltinPins = stored.pins.flatMap((pin) =>
      pin.kind === "skill" &&
      pin.key.startsWith("skills:skill:panda-force.essentials:") &&
      (!pin.label.labels?.["zh-HK"] || !pin.label.labels?.["zh-TW"])
        ? [pin.key]
        : [],
    ),
    resolved = await catalog.getMany([...portablePins, ...legacyBuiltinPins], owner),
    labels = new Map(resolved.flatMap((item) => (item ? [[item.key, item.label] as const] : []))),
    publications = new Set(resolved.filter((item) => item && isPublishingTemplate(item)).map((item) => item!.key)),
    assignments = Object.fromEntries(
      Object.entries(stored.assignments).map(([key, ids]) => [key, ids.filter((id) => allowed.has(id))]),
    );
  return {
    ...stored,
    categories,
    pins: stored.pins
      .filter((pin) => {
        if (pin.kind === "category") return allowed.has(pin.id);
        const kind = pin.key.split(":")[1];
        return kind !== "site-theme" && kind !== "channel-template" && !publications.has(pin.key);
      })
      .map((pin) => {
        const current = pin.kind === "skill" ? labels.get(pin.key) : null;
        if (pin.kind !== "skill" || !current) return pin;
        return { ...pin, label: { ...pin.label, labels: { ...current.labels, ...pin.label.labels } } };
      }),
    assignments,
  };
}
