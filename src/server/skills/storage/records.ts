import { validateSkillManifest } from "../../../shared/skills/manifest.js";
import { freezeSkillValue } from "../../../shared/skills/resources.js";
import { skillOrigin, skillDigest } from "../../../shared/skills/registry-validation.js";
import { SKILL_CAPABILITIES, type SkillCapability } from "../../../shared/skills/contracts.js";
import type { InstalledSkillPack } from "../../../shared/skills/registry.js";
import { SkillRegistryError } from "../errors.js";
export interface SkillRegistryRow {
  id: string;
  version: string;
  digest: string;
  manifest: string;
  origin: string;
  grants: string;
  installedAt: number;
  installedBy: string;
  removed: number;
  active: number;
}
export function installedSkillRecord(
  row: SkillRegistryRow,
  exports: { id: string; enabled: boolean }[],
): InstalledSkillPack {
  try {
    const manifest = validateSkillManifest(JSON.parse(row.manifest)),
      origin = skillOrigin(JSON.parse(row.origin)),
      grants = JSON.parse(row.grants) as SkillCapability[];
    if (
      manifest.id !== row.id ||
      manifest.version !== row.version ||
      !Number.isSafeInteger(row.installedAt) ||
      !Array.isArray(grants) ||
      new Set(grants).size !== grants.length ||
      grants.some((v) => !SKILL_CAPABILITIES.includes(v)) ||
      exports.length !== manifest.skills.length ||
      exports.some((v) => !manifest.skills.some((s) => s.id === v.id))
    )
      throw Error("Invalid registry metadata");
    return freezeSkillValue({
      ...row,
      digest: skillDigest(row.digest),
      manifest,
      origin,
      grants,
      exports,
      removed: !!row.removed,
      active: !!row.active,
    });
  } catch {
    throw new SkillRegistryError("unavailable");
  }
}
