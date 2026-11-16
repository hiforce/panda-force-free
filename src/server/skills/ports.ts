import type { VerifiedSkillPack } from "../../shared/skills/contracts.js";
import type {
  InstalledSkillPack,
  SkillCapture,
  SkillRegistryPage,
  SkillRegistryAudit,
  SkillPackDetail,
} from "../../shared/skills/registry.js";
export interface SkillBundleStore {
  put(value: VerifiedSkillPack): Promise<void>;
  read(digest: string): Promise<VerifiedSkillPack>;
}
export interface SkillMutation {
  id: string;
  actor: string;
  expectedRevision: number;
  now: number;
  request: string;
}
export type SkillRegistryCommand =
  | { kind: "install"; pack: Omit<InstalledSkillPack, "active" | "installedAt" | "installedBy" | "removed"> }
  | { kind: "activate"; id: string; version: string }
  | { kind: "exports"; id: string; version: string; exports: readonly { id: string; enabled: boolean }[] }
  | { kind: "remove"; id: string; version: string };
export interface SkillRegistryStore {
  revision(): Awaitable<number>;
  get(id: string, version: string): Awaitable<InstalledSkillPack | null>;
  detail(id: string, version: string): Awaitable<SkillPackDetail>;
  active(id: string): Awaitable<InstalledSkillPack | null>;
  known(id: string): Awaitable<boolean>;
  list(cursor?: string, limit?: number): Awaitable<SkillRegistryPage>;
  audit(after?: number, limit?: number): Awaitable<SkillRegistryAudit[]>;
  replay(actor: string, id: string, request: string): Awaitable<InstalledSkillPack | null>;
  apply(command: SkillRegistryCommand, mutation: SkillMutation): Awaitable<InstalledSkillPack>;
  captured(owner: string, id: string, request: string): Awaitable<SkillCapture | null>;
  captureById(owner: string, id: string): Awaitable<SkillCapture | null>;
  capture(value: SkillCapture, request: string, expectedRevision: number): Awaitable<SkillCapture>;
}
type Awaitable<T> = T | Promise<T>;
