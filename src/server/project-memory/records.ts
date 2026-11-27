import type { MemoryMaterialHit } from "../../shared/project-memory/materials.js";
import type { MemoryPolicy, MemoryEntry, MemorySourcePolicy } from "../../shared/project-memory/contracts.js";
import { createHash } from "node:crypto";
import type { HarnessConversation } from "../../shared/harness/contracts.js";
import type { ProjectSessionCheckpoint } from "../projects/session-membership.js";
import type { MemoryClaim } from "./rules.js";

export const policyKind = "project-memory-policy";
export const jobKind = "project-memory-job";
export const modelJobKind = "project-memory-model-job";
export const evidenceKey = (id: string) => `memory-evidence:${id}`;
export const evidenceKind = "project-memory-evidence";
export const replacementKind = "project-memory-replacement";
export const recallKind = "project-memory-recall";
export const sourceKey = (id: string) => `memory-source:${id}`;
export const nativeMemoryKind = "memory-native-source";
export const nativeMemoryKey = (id: string) => `memory-native-source:${id}`;
export const conversationKey = (id: string) => `conversation:${id}`;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const namespace = (owner: string, projectId: string) => `pm:${digest([owner, projectId])}`;
export const policyKey = (owner: string, projectId: string) => `memory-policy:${namespace(owner, projectId)}`;

export interface PausedMemoryRange {
  afterSeq: number;
  throughSeq: number;
}
export type SourcePolicy = Omit<MemorySourcePolicy, "paused"> & {
  withdrawnThrough?: ProjectSessionCheckpoint;
  pausedAfterSeq?: number;
  pausedRanges?: PausedMemoryRange[];
};
export const defaultPolicy: MemoryPolicy = { revision: 0, write: false, recall: false };
export const defaultSource: SourcePolicy = { revision: 0, write: null, recall: null, generation: 0 };

export interface MemoryJob {
  owner: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  seq: number;
  throughBytes: number;
  policyRevision: number;
  generation: number;
  createdAt: number;
  attempts: number;
  modelOnly?: true;
  modelStarted?: true;
}
export type MemoryConversation = Pick<
  HarnessConversation,
  "id" | "owner" | "projectId" | "revision" | "cwd" | "archivedAt" | "historyBytes" | "lastSeq"
> &
  Partial<Pick<HarnessConversation, "title" | "activeRunId" | "memoryPrivate">> & { nativeId?: string };
export interface MemoryOrder {
  id: string;
  recordedAt: number;
}
export const compareMemoryOrder = (left: MemoryOrder, right: MemoryOrder) =>
  left.recordedAt - right.recordedAt || left.id.localeCompare(right.id);
export const entryId = (key: string, scope: string) => digest([key, scope]);
export const entryVersion = (id: string, value: string) => digest([id, value]);

interface EvidenceRecord extends MemoryClaim {
  id: string;
  recordedAt: number;
  projectedFrom?: string;
}
export type MemoryEvidence = EvidenceRecord &
  (
    | {
        conversationId: string;
        messageId: string;
        generation: number;
        throughBytes?: number;
        packageId?: never;
        legacy?: never;
      }
    | {
        packageId: string;
        conversationId?: never;
        messageId?: never;
        generation?: never;
        throughBytes?: never;
        legacy?: never;
      }
    | {
        legacy: { id: string; cwd: string };
        conversationId?: never;
        messageId?: never;
        generation?: never;
        throughBytes?: never;
        packageId?: never;
      }
  );
export interface MemoryRecall {
  id: string;
  version: string;
  sources: MemoryEntry["sources"];
  packages?: string[];
  manual?: string[];
  team?: true;
  projectId?: string;
  material?: Omit<MemoryMaterialHit, "excerpt">;
  visual?: true;
}
export interface MemoryReceipt {
  runId: string;
  nativeSessionId: string;
  status: "possible" | "sent" | "indexUnavailable";
  references: MemoryRecall[];
}
