import type { MemoryMaterialHit } from "./materials.js";
import type { RuntimeSelection } from "../engine/runtime-selection.js";

export interface MemoryPreferences {
  revision: number;
  language: string;
}

export interface ProjectMemoryLanguage {
  revision: number;
  language: string | null;
  inheritedLanguage: string;
}

export interface MemoryPolicy {
  revision: number;
  write: boolean;
  recall: boolean;
  model?: MemoryModelPolicy;
}
export interface MemoryModelPolicy {
  enabled: boolean;
  selection: RuntimeSelection | null;
}

export interface MemoryModelCandidate {
  key: string;
  scope: string;
  value: string;
  quote: string;
  offset: number;
  intent: "decision" | "proposal" | "uncertain";
}

export interface MemoryModelReview {
  conversationId: string;
  messageId: string;
  finishedAt: number;
  status: "candidates" | "empty" | "budget" | "unavailable" | "unverified";
  candidates: MemoryModelCandidate[];
  durationMs: number;
  tokens: number | null;
}

export interface MemoryIndexStatus {
  backend: "local" | "elasticsearch";
  state: "pending" | "ready" | "unavailable";
  fallback: boolean;
  cleanupPending: boolean;
}

export const isProjectMemoryScope = (scope: string) => scope === "project" || scope === "user";

export interface MemoryEntry {
  id: string;
  key: string;
  title?: string;
  scope: string;
  state: "active" | "conflict" | "withdrawn";
  value: string | null;
  version: string | null;
  sources: Array<{ conversationId: string; messageId: string }>;
  packages?: string[];
  manual?: string[];
  team?: true;
}

export interface MemoryTeamPreview {
  entryId: string;
  key: string;
  scope: string;
  value: string;
  token: string;
}
export interface MemoryTeamPublication {
  entryId: string;
  key: string;
  scope: string;
  revision: number;
  active: boolean;
}
export interface MemoryTeamView {
  entries: MemoryEntry[];
  publications: MemoryTeamPublication[];
  canPublish: boolean;
}

export type MemoryTransition =
  "recorded" | "corroborated" | "conflict" | "replaced" | "recovered" | "sourceWithdrawn" | "withdrawn";
export interface MemoryVersion {
  revision: number;
  changedAt: number;
  reason: MemoryTransition;
  entry: MemoryEntry | null;
}
export interface MemoryDetail {
  current: MemoryEntry | null;
  versions: MemoryVersion[];
  next: number | null;
}
export interface MemoryRemovalImpact {
  token: string;
  stops: number;
  retains: number;
  recovers: number;
  pauses: number;
}

export interface MemorySourcePolicy {
  revision: number;
  write: boolean | null;
  recall: boolean | null;
  generation: number;
  paused: boolean;
}
export interface MemorySessionPolicy {
  policy: MemoryPolicy;
  source: MemorySourcePolicy;
}
export interface MemoryBackfillTask {
  from: number;
  to: number;
  state: "queued" | "running" | "complete" | "stopped" | "failed";
  progress: number;
  added: number;
  updatedAt: number;
}
export interface MemoryBackfillView {
  availability: "available" | "paused" | "writeDisabled" | "boundaryUnavailable" | "forbidden";
  task: MemoryBackfillTask | null;
}
export const legacyMemoryPath = "/api/personal/harness/legacy-memory/";

export interface MemoryManualConvention {
  key: string;
  scope: string;
  value: string;
}

export interface MemoryLegacySessionView {
  canSave: boolean;
  automatic: { revision: number; enabled: boolean; paused: boolean; organizerEnabled: boolean; contributed: number };
  entries: MemoryManualConvention[];
}

export interface MemorySessionSummary extends MemorySessionPolicy {
  contributed: number;
  recalled: number;
  pending: number;
  backfill: MemoryBackfillView;
}

export interface MemorySessionDetail {
  contributions: {
    entries: MemoryEntry[];
    pending: number;
    failed: number;
  };
  recalls: Array<{
    runId: string;
    status: "possible" | "sent" | "indexUnavailable";
    references: Array<{
      id: string;
      version: string;
      sources: MemoryEntry["sources"];
      packages?: string[];
      manual?: string[];
      team?: true;
      material?: Omit<MemoryMaterialHit, "excerpt">;
      visual?: true;
    }>;
  }>;
}

export const organizedMemoryRelationKinds = ["related", "dependsOn", "refines"] as const;
export type OrganizedMemoryRelationKind = (typeof organizedMemoryRelationKinds)[number];
export type MemoryRelationKind = OrganizedMemoryRelationKind | "sameTopic" | "sameSource";

export interface MemoryTerrainLink {
  from: string;
  to: string;
  kind: MemoryRelationKind;
  source?: MemoryEntry["sources"][number];
}

export interface MemoryTerrainPlace {
  slot: number;
  entry: MemoryEntry;
  depth?: 0 | 1 | 2;
  time?: { at: number; source: boolean };
}

export interface MemoryTerrain {
  topics: Array<{ id: string; name: string; title?: string }>;
  topic: string | null;
  plates: string[];
  plate: string | null;
  places: MemoryTerrainPlace[];
  place?: string;
  links: MemoryTerrainLink[];
  related: Array<Pick<MemoryEntry, "id" | "key" | "title">>;
}

export interface MemorySourceLocation {
  title: string | null;
  nativeConversationId?: string;
  message: { id: string; text: string; createdAt: number; sequence: number };
}
