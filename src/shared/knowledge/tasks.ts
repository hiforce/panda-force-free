import type { SavedSourceKind } from "../content-sources/contracts.js";
import type { KnowledgeDraft, KnowledgeEvidenceSource } from "./contracts.js";
import type { KnowledgeApproval, KnowledgeAutomaticReview, KnowledgeReviewReport } from "./review.js";

export type KnowledgeTaskState =
  "queued" | "running" | "waiting" | "review" | "committing" | "completed" | "failed" | "cancelled" | "stale";

export type KnowledgeFailure =
  "interrupted" | "budget" | "sourceChanged" | "targetChanged" | "invalidOutput" | "unavailable";

export interface KnowledgeScope {
  project: string;
}

export interface KnowledgeSelection extends KnowledgeScope {
  ids: string[];
  contentKinds?: SavedSourceKind[];
}

export interface KnowledgeTask {
  origin?: { kind: "rule"; version: string; policyRevision: number; manual: boolean } & (
    { documentId: string } | { sourceId: string; sourceKind: Exclude<SavedSourceKind, "document"> }
  );
  manualReviewRequired?: boolean;
  id: string;
  title: string;
  project: string;
  state: KnowledgeTaskState;
  generation: number;
  attempts: number;
  rounds: number;
  reviewRevision: number;
  failure: KnowledgeFailure | null;
  result: KnowledgeReceipt | null;
  createdAt: number;
  updatedAt: number;
  automaticReview?: KnowledgeAutomaticReview | null;
}
export interface KnowledgeTaskPage {
  tasks: KnowledgeTask[];
  nextCursor: string | null;
}

export interface KnowledgeQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface KnowledgeAnswer {
  questionId: string;
  answer: string;
}

export interface KnowledgeDialogue {
  questions: KnowledgeQuestion[];
  answers: KnowledgeAnswer[];
}

export interface KnowledgeTaskInput {
  schema: 1;
  scope: KnowledgeSelection;
  purpose: string;
  sources: KnowledgeEvidenceSource[];
  sourceCommit: string;
  profile: { id: string; engineId: string; model: string; activeTimeoutMs: number };
  target: {
    id: string;
    expectedVersion: string | null;
    previous?: { digest: string; state: string; reviewRequired: boolean };
  };
}

export interface KnowledgePrevious {
  schema: 1;
  id: string;
  files: { json: string | null; markdown: string | null };
  json: string | null;
  markdown: string | null;
}
export interface KnowledgePreviousSummary {
  state: string;
  title: string;
  reviewRequired: boolean;
}

export interface KnowledgeReceipt {
  id: string;
  version: string;
  commit: string;
}

export interface KnowledgeTaskDetail {
  task: KnowledgeTask;
  purpose: string;
  sources: Omit<KnowledgeEvidenceSource, "text" | "sections">[];
  dialogue: KnowledgeDialogue;
  draft: KnowledgeDraft | null;
  sourceCurrent: boolean;
  previous?: KnowledgePreviousSummary;
}

export interface KnowledgeRecord {
  schema: 1;
  id: string;
  version: string;
  previousVersion: string | null;
  taskId: string;
  sourceCommit: string;
  sources: Omit<KnowledgeEvidenceSource, "text" | "sections">[];
  draft: KnowledgeDraft;
  approvedAt: number;
  approval?: KnowledgeApproval;
  review?: KnowledgeReviewReport;
}

export const KNOWLEDGE_LIMITS = Object.freeze({
  contextCharacters: 512000,
  sources: 32,
  sourceBytes: 384 * 1024,
  purposeBytes: 4096,
  activeTimeoutMs: 180000,
  attempts: 3,
  rounds: 8,
  questionCount: 3,
  pageSize: 50,
  pendingPerOwner: 32,
  automaticReviewBytes: 512 * 1024,
  previousFileBytes: 1024 * 1024,
  previousBytes: 10 * 1024 * 1024,
});
