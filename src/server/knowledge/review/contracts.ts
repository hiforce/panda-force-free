import type { KnowledgeAutomaticReview, KnowledgeReviewPolicy } from "../../../shared/knowledge/review.js";
import type { KnowledgeTaskRow } from "../tasks/contracts.js";
import type { ApplicationRunScope } from "../../../shared/engine/application-tools.js";

export interface KnowledgeReviewLease extends KnowledgeAutomaticReview {
  taskId: string;
  owner: string;
  project: string;
  token: string;
  leaseUntil: number;
  inputDigest: string;
  dialogueDigest: string;
  draftDigest: string;
  sessionId: string | null;
  runId: string | null;
  reportDigest: string | null;
}
export interface KnowledgeReviewPolicies {
  policy(owner: string, project: string): KnowledgeReviewPolicy;
  configure(owner: string, project: string, automatic: boolean, revision: number, now: number): KnowledgeReviewPolicy;
}
export interface KnowledgeReviewExecutions {
  claim(now: number): { review: KnowledgeReviewLease; task: KnowledgeTaskRow } | null;
  assert(review: KnowledgeReviewLease, now: number): void;
  bind(review: KnowledgeReviewLease, scope: ApplicationRunScope, now: number): KnowledgeReviewLease;
  heartbeat(review: KnowledgeReviewLease, now: number): void;
  fail(review: KnowledgeReviewLease, now: number): void;
}
export interface KnowledgeReviewDecisions {
  latest(owner: string, taskId: string): KnowledgeReviewLease | null;
  latestFor(owner: string, taskIds: readonly string[]): KnowledgeReviewLease[];
  finish(review: KnowledgeReviewLease, reportDigest: string, approved: boolean, now: number): void;
  admit(review: KnowledgeReviewLease, reportDigest: string, outputDigest: string, now: number): void;
  pending(): KnowledgeReviewLease | null;
}
export interface KnowledgeReviewStore
  extends KnowledgeReviewPolicies, KnowledgeReviewExecutions, KnowledgeReviewDecisions {}
