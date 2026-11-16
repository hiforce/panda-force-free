import { templateSections, type TemplateSection } from "../../shared/templates/sections.js";
import { isRecord } from "../../shared/records.js";
import {
  builtinSkillCategories,
  SKILL_WORKSPACE_LIMITS as limits,
  skillPinId,
  type SkillWorkspaceSnapshot,
} from "../../shared/skill-workspace.js";

/** Stored preference corruption must be visible, rather than silently replacing user choices. */
export function storedWorkspace(json: string): SkillWorkspaceSnapshot {
  const value = JSON.parse(json);
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.categories) ||
    value.categories.length > limits.categories ||
    !Array.isArray(value.pins) ||
    value.pins.length > limits.pins ||
    !isRecord(value.assignments) ||
    Object.keys(value.assignments).length > limits.assignments
  )
    throw new Error("Invalid stored workspace");
  const categories = new Set<string>();
  for (const c of value.categories) {
    if (
      !isRecord(c) ||
      typeof c.id !== "string" ||
      categories.has(c.id) ||
      !isRecord(c.name) ||
      typeof c.name.en !== "string" ||
      !c.name.en.trim() ||
      c.name.en.length > limits.name ||
      typeof c.name["zh-CN"] !== "string" ||
      !c.name["zh-CN"].trim() ||
      c.name["zh-CN"].length > limits.name ||
      ["zh-HK", "zh-TW"].some(
        (locale) =>
          c.name &&
          isRecord(c.name) &&
          c.name[locale] !== undefined &&
          (typeof c.name[locale] !== "string" || (c.name[locale] as string).length > limits.name),
      ) ||
      typeof c.icon !== "string" ||
      c.icon.length > 64 ||
      (c.section !== undefined && !templateSections.includes(c.section as TemplateSection)) ||
      typeof c.builtin !== "boolean"
    )
      throw new Error("Invalid category");
    // Legacy publication preferences remain readable without reseeding them as skills.
    const section =
      builtinSkillCategories.find((b) => b.id === c.id)?.section ||
      (c.id === "site" ? "site" : c.id === "channel" ? "channel" : undefined);
    if (c.builtin ? !section || c.section !== section : !/^custom-[a-f0-9-]{36}$/.test(c.id))
      throw new Error("Invalid category identity");
    categories.add(c.id);
  }
  if (
    value.assignmentOverrides !== undefined &&
    (!Array.isArray(value.assignmentOverrides) ||
      value.assignmentOverrides.length > limits.assignments ||
      new Set(value.assignmentOverrides).size !== value.assignmentOverrides.length ||
      value.assignmentOverrides.some(
        (key) => typeof key !== "string" || !Object.hasOwn(value.assignments as object, key),
      ))
  )
    throw new Error("Invalid assignment overrides");
  const pins = new Set<string>();
  for (const p of value.pins) {
    if (
      !isRecord(p) ||
      (p.kind === "category"
        ? typeof p.id !== "string" || !categories.has(p.id)
        : p.kind !== "skill" ||
          typeof p.key !== "string" ||
          !p.key ||
          p.key.length > 1400 ||
          typeof p.version !== "string" ||
          p.version.length > 160 ||
          !isRecord(p.label))
    )
      throw new Error("Invalid shortcut");
    const id = skillPinId(p as SkillWorkspaceSnapshot["pins"][number]);
    if (pins.has(id)) throw new Error("Duplicate shortcut");
    pins.add(id);
  }
  for (const [lineage, ids] of Object.entries(value.assignments)) {
    if (
      !lineage ||
      lineage.length > 1400 ||
      !Array.isArray(ids) ||
      ids.length > limits.categories ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !categories.has(id))
    )
      throw new Error("Invalid assignment");
  }
  return value as unknown as SkillWorkspaceSnapshot;
}
