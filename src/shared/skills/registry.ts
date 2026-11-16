import type { ImmutableSkillData, SkillCapability, SkillPackManifest } from "./contracts.js";
import type { SkillComposition } from "./composition.js";

/** Source adapters establish provenance; a manifest's self-reported publisher is not authentication. */
export type SkillPackOrigin =
  | { kind: "upload"; name: string; sha256: string }
  | { kind: "github"; repository: string; commit: string; packagePath: string; sha256: string }
  | { kind: "builtin"; id: string };
export interface InstalledSkillPack {
  id: string;
  version: string;
  digest: string;
  manifest: ImmutableSkillData<SkillPackManifest>;
  origin: SkillPackOrigin;
  installedAt: number;
  installedBy: string;
  removed: boolean;
  active: boolean;
  exports: readonly { id: string; enabled: boolean }[];
  grants: readonly SkillCapability[];
}
export interface SkillInstallReview {
  digest: string;
  revision: number;
  reviewHash: string;
  manifest: ImmutableSkillData<SkillPackManifest>;
  origin: SkillPackOrigin;
  selected: readonly string[];
  capabilities: readonly SkillCapability[];
  addedCapabilities: readonly SkillCapability[];
  activeVersion: string | null;
  installed: boolean;
  sourceChanged: boolean;
  byteLength: number;
  fileCount: number;
}
export interface SkillCapture {
  id: string;
  owner: string;
  requestBinding: string;
  registryRevision: number;
  createdAt: number;
  composition: ImmutableSkillData<SkillComposition>;
  origins: readonly { id: string; version: string; digest: string; origin: SkillPackOrigin }[];
}
export interface SkillRegistryPage {
  revision: number;
  packages: InstalledSkillPack[];
  nextCursor: string | null;
}
export interface SkillPackDetail {
  revision: number;
  package: InstalledSkillPack | null;
}
export interface SkillRegistryAudit {
  sequence: number;
  revision: number;
  action: "install" | "activate" | "exports" | "remove";
  id: string;
  version: string;
  digest: string;
  actor: string;
  operationId: string;
  createdAt: number;
  details: unknown;
}
