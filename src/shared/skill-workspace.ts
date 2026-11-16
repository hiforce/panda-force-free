import { templateLineageKey, type TemplateNativeReference } from "./templates/catalog.js";
import type { PresentationLabel } from "./presentation/labels.js";
import type { TemplateSection } from "./templates/sections.js";
export type SkillCategoryName = { en: string; "zh-CN": string; "zh-HK"?: string; "zh-TW"?: string };
export const SKILL_WORKSPACE_LIMITS = { categories: 40, pins: 24, assignments: 2000, name: 64 } as const;
export interface SkillCategory {
  id: string;
  name: SkillCategoryName;
  icon: string;
  /** Retained seed provenance; it does not restrict category management. */
  builtin: boolean;
  section?: TemplateSection;
}
export const builtinSkillCategories: readonly SkillCategory[] = [
  {
    id: "writing",
    name: { en: "Writing", "zh-CN": "写作", "zh-HK": "寫作", "zh-TW": "寫作" },
    icon: "file",
    builtin: true,
    section: "writing",
  },
  {
    id: "research",
    name: { en: "Research", "zh-CN": "研究", "zh-HK": "研究", "zh-TW": "研究" },
    icon: "search",
    builtin: true,
    section: "research",
  },
  {
    id: "slides",
    name: { en: "Slides", "zh-CN": "幻灯片", "zh-HK": "投影片", "zh-TW": "簡報" },
    icon: "monitor",
    builtin: true,
    section: "slides",
  },
  {
    id: "image",
    name: { en: "Images", "zh-CN": "图片", "zh-HK": "圖片", "zh-TW": "圖片" },
    icon: "image",
    builtin: true,
    section: "image",
  },
  {
    id: "web",
    name: { en: "Web", "zh-CN": "网页", "zh-HK": "網頁", "zh-TW": "網頁" },
    icon: "globe",
    builtin: true,
    section: "web",
  },
  {
    id: "video",
    name: { en: "Video", "zh-CN": "视频", "zh-HK": "影片", "zh-TW": "影片" },
    icon: "play",
    builtin: true,
    section: "video",
  },
];
/** Publishing sections are resource views, not configurable AI skill categories. */
export function isSkillCategory(category: Pick<SkillCategory, "section">): boolean {
  return category.section !== "site" && category.section !== "channel";
}
export type SkillPinInput = { kind: "category"; id: string } | { kind: "skill"; key: string };
export type SkillPin =
  { kind: "category"; id: string } | { kind: "skill"; key: string; label: PresentationLabel; version: string };
export interface SkillWorkspaceSnapshot {
  revision: number;
  categories: SkillCategory[];
  pins: SkillPin[];
  assignments: Record<string, string[]>;
  assignmentOverrides?: string[];
}
export type SkillWorkspaceCommand =
  | { type: "pins"; pins: SkillPinInput[] }
  | { type: "reset-pins" }
  | { type: "create-category"; id: string; name: SkillCategoryName }
  | { type: "rename-category"; id: string; name: SkillCategoryName }
  | { type: "delete-category"; id: string }
  | { type: "assign"; key: string; categoryIds: string[]; replaceDefaults?: boolean };
export interface SkillWorkspaceMutation {
  operationId: string;
  expectedRevision: number;
  command: SkillWorkspaceCommand;
}
export function skillPinId(pin: SkillPinInput): string {
  return pin.kind === "category" ? "category:" + pin.id : "skill:" + pin.key;
}
export function defaultSkillWorkspace(): SkillWorkspaceSnapshot {
  return {
    revision: 0,
    categories: structuredClone([...builtinSkillCategories]),
    pins: ["writing", "slides", "image", "web", "video"].map((id) => ({ kind: "category" as const, id })),
    assignments: {},
  };
}
export class SkillWorkspaceError extends Error {
  constructor(readonly code: "invalidInput" | "conflict" | "categoryMissing" | "skillUnavailable" | "unavailable") {
    super(code);
  }
}

export interface SkillCategoryFilter {
  section?: TemplateSection;
  includeLineages: string[];
  excludeLineages: string[];
}
/** Defaults supply initial matching rules; explicit choices override them without rewriting packages. */
export function assignedSkillCategories(
  snapshot: SkillWorkspaceSnapshot,
  reference: TemplateNativeReference,
  matchesDefault: (section: TemplateSection) => boolean,
) {
  const lineage = templateLineageKey(reference),
    ids = snapshot.assignments[lineage] || [],
    explicit = snapshot.assignmentOverrides?.includes(lineage);
  return snapshot.categories
    .filter(
      (category) =>
        isSkillCategory(category) &&
        (ids.includes(category.id) || (!explicit && category.section && matchesDefault(category.section))),
    )
    .map((category) => category.id);
}
export function configuredCategoryFilter(snapshot: SkillWorkspaceSnapshot, id: string): SkillCategoryFilter | null {
  const category = snapshot.categories.find((value) => value.id === id && isSkillCategory(value));
  if (!category) return null;
  const explicit = new Set(snapshot.assignmentOverrides || []),
    includeLineages: string[] = [],
    excludeLineages: string[] = [];
  for (const [key, ids] of Object.entries(snapshot.assignments)) {
    if (ids.includes(id)) includeLineages.push(key);
    else if (explicit.has(key)) excludeLineages.push(key);
  }
  return { ...(category.section ? { section: category.section } : {}), includeLineages, excludeLineages };
}
export function skillCategoryPredicate(filter: SkillCategoryFilter) {
  const included = new Set(filter.includeLineages),
    excluded = new Set(filter.excludeLineages);
  return (lineage: string, matchesDefault: (section: TemplateSection) => boolean) =>
    !excluded.has(lineage) && (included.has(lineage) || (!!filter.section && matchesDefault(filter.section)));
}
