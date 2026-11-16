import {
  SkillWorkspaceError,
  SKILL_WORKSPACE_LIMITS as limits,
  skillPinId,
  type SkillWorkspaceMutation,
  type SkillWorkspaceCommand,
  type SkillPinInput,
} from "../../shared/skill-workspace.js";
import { REQUIRED_LOCALE_CODES } from "../../shared/i18n/locale-policy.js";
const fail = (): never => {
  throw new SkillWorkspaceError("invalidInput");
};
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) return fail();
  return value.trim();
}
export const workspaceKey = (value: unknown) => text(value, 1400);
export function categoryId(value: unknown) {
  const id = text(value, 80);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)) return fail();
  return id;
}
function name(value: unknown) {
  const row = object(value, REQUIRED_LOCALE_CODES);
  const optional = (locale: "zh-HK" | "zh-TW") =>
    row[locale] === undefined
      ? {}
      : {
          [locale]: row[locale] === "" ? "" : text(row[locale], limits.name),
        };
  return {
    en: text(row.en, limits.name),
    "zh-CN": text(row["zh-CN"], limits.name),
    ...optional("zh-HK"),
    ...optional("zh-TW"),
  };
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value.map(parse);
}
function command(value: unknown): SkillWorkspaceCommand {
  const type = object(value, ["type", "pins", "id", "name", "key", "categoryIds", "replaceDefaults"]).type;
  if (type === "pins") {
    const row = object(value, ["type", "pins"]),
      pins = list<SkillPinInput>(row.pins, limits.pins, (value) => {
        const kind = object(value, ["kind", "id", "key"]).kind;
        if (kind === "category") return { kind, id: categoryId(object(value, ["kind", "id"]).id) };
        if (kind === "skill") return { kind, key: workspaceKey(object(value, ["kind", "key"]).key) };
        return fail();
      });
    if (new Set(pins.map(skillPinId)).size !== pins.length) return fail();
    return { type, pins };
  }
  if (type === "reset-pins") {
    object(value, ["type"]);
    return { type };
  }
  if (type === "create-category" || type === "rename-category") {
    const row = object(value, ["type", "id", "name"]),
      id = categoryId(row.id);
    if (type === "create-category" && !/^custom-[a-f0-9-]{36}$/.test(id)) return fail();
    return { type, id, name: name(row.name) };
  }
  if (type === "delete-category") return { type, id: categoryId(object(value, ["type", "id"]).id) };
  if (type === "assign") {
    const row = object(value, ["type", "key", "categoryIds", "replaceDefaults"]),
      categoryIds = list(row.categoryIds, limits.categories, categoryId);
    if (new Set(categoryIds).size !== categoryIds.length) return fail();
    if (row.replaceDefaults !== undefined && typeof row.replaceDefaults !== "boolean") return fail();
    return {
      type,
      key: workspaceKey(row.key),
      categoryIds,
      ...(row.replaceDefaults === undefined ? {} : { replaceDefaults: row.replaceDefaults as boolean }),
    };
  }
  return fail();
}
export function workspaceMutation(value: unknown): SkillWorkspaceMutation {
  const row = object(value, ["operationId", "expectedRevision", "command"]),
    operationId = text(row.operationId, 36);
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(operationId) ||
    !Number.isSafeInteger(row.expectedRevision) ||
    (row.expectedRevision as number) < 0
  )
    return fail();
  return { operationId, expectedRevision: row.expectedRevision as number, command: command(row.command) };
}
