import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import {
  SKILL_CAPABILITIES,
  SKILL_LIMITS,
  type SkillCapability,
  type VerifiedSkillPack,
} from "../../../shared/skills/contracts.js";
import { verifySkillResources } from "../../../shared/skills/resources.js";
import { localId } from "../../../shared/skills/manifest/identity.js";
import { record, text } from "../../../shared/skills/manifest/primitives.js";
import { skillOperationId } from "../../../shared/skills/registry-validation.js";
import { SkillRegistryError } from "../errors.js";
export const requestHash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export function actor(value: unknown): string {
  return text(value, 200, "actor");
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new SkillRegistryError("invalidInput");
  return Number(value);
}
export function clock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SkillRegistryError("invalidInput");
  return value;
}
export function operation(value: unknown) {
  return skillOperationId(value);
}
export function selectedExports(value: unknown, pack: VerifiedSkillPack): string[] {
  if (!Array.isArray(value) || !value.length || value.length > SKILL_LIMITS.exports)
    throw new SkillRegistryError("invalidInput");
  const ids = value.map(localId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !pack.manifest.skills.some((skill) => skill.id === id)))
    throw new SkillRegistryError("invalidInput");
  return ids.sort();
}
export function grants(value: unknown): SkillCapability[] {
  if (
    !Array.isArray(value) ||
    value.length > SKILL_CAPABILITIES.length ||
    new Set(value).size !== value.length ||
    value.some((item) => !SKILL_CAPABILITIES.includes(item))
  )
    throw new SkillRegistryError("approvalRequired");
  return [...value].sort() as SkillCapability[];
}
export async function ownedPack(pack: VerifiedSkillPack): Promise<VerifiedSkillPack> {
  if (!Array.isArray(pack.resources) || pack.resources.length > SKILL_LIMITS.files)
    throw new SkillRegistryError("invalidInput");
  const normalized = await verifySkillResources(
    pack.readManifest(),
    pack.resources.map((file) => ({ path: file.path, bytes: pack.read(file.path) })),
  );
  if (normalized.digest !== pack.digest) throw new SkillRegistryError("reviewChanged");
  return normalized;
}
export function parameters(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillRegistryError("invalidInput");
  const row = record(value, Object.keys(value));
  if (Object.keys(row).length > 32) throw new SkillRegistryError("invalidInput");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(row)) {
    localId(key);
    if (
      !["string", "number", "boolean"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item)) ||
      (typeof item === "string" && item.length > 4000)
    )
      throw new SkillRegistryError("invalidInput");
    result[key] = item as string | number | boolean;
  }
  return result;
}
