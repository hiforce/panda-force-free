import { createHash } from "node:crypto";
import {
  configuredCategoryFilter,
  defaultSkillWorkspace,
  isSkillCategory,
  SKILL_WORKSPACE_LIMITS,
  SkillWorkspaceError,
  skillPinId,
  type SkillPin,
  type SkillWorkspaceSnapshot,
  type SkillCategoryName,
} from "../../shared/skill-workspace.js";
import { templateLineageKey } from "../../shared/templates/catalog.js";
import { isPublishingTemplate } from "../../shared/templates/domain.js";
import type { TemplateCatalog } from "../templates/catalog.js";
import type { SkillWorkspaceRepository } from "./ports.js";
import { categoryId, workspaceMutation, workspaceKey } from "./validation.js";
import { skillWorkspaceProjection } from "./projection.js";

function localizedName(current: Partial<SkillCategoryName>, next: SkillCategoryName): SkillCategoryName {
  return { ...current, ...next };
}

export function configuredCollection(snapshot: SkillWorkspaceSnapshot, value: string) {
  const categoryFilter = configuredCategoryFilter(snapshot, categoryId(value));
  if (!categoryFilter) throw new SkillWorkspaceError("categoryMissing");
  return { categoryFilter, personalRevision: snapshot.revision, domain: "skills" as const };
}
export class SkillWorkspaceService {
  constructor(
    private store: SkillWorkspaceRepository,
    private catalog: TemplateCatalog,
  ) {}
  async snapshot(owner: string) {
    return skillWorkspaceProjection(await this.store.read(owner), this.catalog, owner);
  }
  async collection(owner: string, value: string) {
    return configuredCollection(await this.store.read(owner), value);
  }
  async skill(owner: string, value: unknown) {
    const key = workspaceKey(value),
      item = (await this.catalog.getMany([key], owner))[0];
    if (!item || isPublishingTemplate(item)) throw new SkillWorkspaceError("skillUnavailable");
    return item;
  }
  async change(owner: string, value: unknown): Promise<SkillWorkspaceSnapshot> {
    const input = workspaceMutation(value),
      request = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const replay = await this.store.replay(owner, input.operationId, request);
    if (replay) return skillWorkspaceProjection(replay, this.catalog, owner);
    const next = await this.store.read(owner),
      command = input.command;
    if (next.revision !== input.expectedRevision) throw new SkillWorkspaceError("conflict");
    const category = (id: string) => {
      const found = next.categories.find((category) => category.id === id && isSkillCategory(category));
      if (!found) throw new SkillWorkspaceError("categoryMissing");
      return found;
    };
    if (command.type === "pins") {
      const visible = await skillWorkspaceProjection(next, this.catalog, owner),
        old = new Map(visible.pins.map((pin) => [skillPinId(pin), pin]));
      const newKeys = command.pins
        .filter((pin) => pin.kind === "skill" && !old.has(skillPinId(pin)))
        .map((pin) => (pin.kind === "skill" ? pin.key : ""));
      const resolved = await this.catalog.getMany(newKeys, owner),
        items = new Map(resolved.filter((item) => item !== null).map((item) => [item.key, item]));
      next.pins = command.pins.map((pin): SkillPin => {
        if (pin.kind === "category") {
          category(pin.id);
          return pin;
        }
        const prior = old.get(skillPinId(pin));
        if (prior) return prior;
        const item = items.get(pin.key);
        if (!item || isPublishingTemplate(item)) throw new SkillWorkspaceError("skillUnavailable");
        return {
          ...pin,
          label: {
            ...(item.label.nameId ? { nameId: item.label.nameId } : {}),
            name: (item.label.name || "").slice(0, 160),
            labels: Object.fromEntries(
              Object.entries(item.label.labels || {})
                .slice(0, 32)
                .map(([locale, label]) => [locale, { name: label.name.slice(0, 160), description: "" }]),
            ),
          },
          version: item.reference.version,
        };
      });
    } else if (command.type === "reset-pins")
      next.pins = defaultSkillWorkspace().pins.filter(
        (pin) => pin.kind !== "category" || next.categories.some((value) => value.id === pin.id),
      );
    else if (command.type === "create-category" || command.type === "rename-category") {
      if (
        next.categories.some(
          (c) =>
            isSkillCategory(c) &&
            c.id !== command.id &&
            (c.name.en.toLocaleLowerCase() === command.name.en.toLocaleLowerCase() ||
              c.name["zh-CN"] === command.name["zh-CN"]),
        )
      )
        throw new SkillWorkspaceError("invalidInput");
      if (command.type === "create-category") {
        if (
          next.categories.length >= SKILL_WORKSPACE_LIMITS.categories ||
          next.categories.some((c) => c.id === command.id)
        )
          throw new SkillWorkspaceError("invalidInput");
        next.categories.push({ id: command.id, name: localizedName({}, command.name), icon: "folder", builtin: false });
      } else {
        const current = category(command.id);
        current.name = localizedName(current.name, command.name);
      }
    } else if (command.type === "delete-category") {
      category(command.id);
      next.categories = next.categories.filter((c) => c.id !== command.id);
      next.pins = next.pins.filter((pin) => pin.kind !== "category" || pin.id !== command.id);
      for (const [key, ids] of Object.entries(next.assignments)) {
        next.assignments[key] = ids.filter((id) => id !== command.id);
        if (!next.assignments[key]!.length && !next.assignmentOverrides?.includes(key)) delete next.assignments[key];
      }
    } else {
      for (const id of command.categoryIds) category(id);
      const item = await this.skill(owner, command.key),
        lineage = templateLineageKey(item.reference);
      if (command.replaceDefaults) {
        next.assignments[lineage] = command.categoryIds;
        next.assignmentOverrides = [...new Set([...(next.assignmentOverrides || []), lineage])];
      } else if (next.assignmentOverrides?.includes(lineage)) {
        // Legacy clients edit additional labels; preserve their unseen configured default memberships.
        const retained = (next.assignments[lineage] || []).filter((id) =>
          next.categories.some((value) => value.id === id && value.section),
        );
        next.assignments[lineage] = [...new Set([...retained, ...command.categoryIds])];
      } else if (command.categoryIds.length) next.assignments[lineage] = command.categoryIds;
      else delete next.assignments[lineage];
      if (Object.keys(next.assignments).length > SKILL_WORKSPACE_LIMITS.assignments)
        throw new SkillWorkspaceError("invalidInput");
    }
    return skillWorkspaceProjection(
      await this.store.save(owner, input.operationId, request, input.expectedRevision, next),
      this.catalog,
      owner,
    );
  }
}
