import type { SkillCapture } from "../../../shared/skills/registry.js";
import type { CreationMaterial, CreationEngineProfile } from "../../../shared/creation/contracts.js";
import type { CreationLease } from "../contracts.js";
import type { CreationResult } from "../ports.js";
export type CreationMessageState = "received" | "dispatching" | "delivered" | "uncertain";
export interface CreationMessageRecord {
  id: string;
  owner: string;
  taskId: string;
  generation: number;
  requestDigest: string;
  payloadDigest: string;
  state: CreationMessageState;
  dispatchGeneration: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface CreationMessageStore {
  find(owner: string, id: string): CreationResult<CreationMessageRecord | null>;
  accept(value: CreationMessageRecord): CreationResult<CreationMessageRecord>;
  list(owner: string, taskId: string): CreationResult<CreationMessageRecord[]>;
  claim(lease: CreationLease, now: number): CreationResult<CreationMessageRecord | null>;
  settle(lease: CreationLease, id: string, state: "delivered" | "uncertain", now: number): CreationResult<void>;
  seen(lease: CreationLease, ids: readonly string[], now: number): CreationResult<void>;
}

export interface CreationMessagePayload {
  schema: 1;
  id: string;
  owner: string;
  taskId: string;
  requestDigest: string;
  prompt: string;
  profile: CreationEngineProfile;
  skills: SkillCapture | null;
  inheritSkills?: true;
  materials: readonly CreationMaterial[];
}

export interface CreationMessageFiles {
  put(value: CreationMessagePayload): Promise<string>;
  read(digest: string): Promise<CreationMessagePayload>;
}
