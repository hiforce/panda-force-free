import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import type { KnowledgeDraftInput } from "../../../shared/knowledge/contracts.js";
import type { KnowledgeReviewReport } from "../../../shared/knowledge/review.js";
import type { KnowledgeCatalogProjection } from "../catalog/contracts.js";
import type {
  KnowledgeDialogue,
  KnowledgeReceipt,
  KnowledgeRecord,
  KnowledgeSelection,
  KnowledgeTask,
  KnowledgeTaskInput,
  KnowledgeFailure,
  KnowledgePrevious,
} from "../../../shared/knowledge/tasks.js";

/** Execution identities are checked against the current lease before any model output is admitted. */
export interface KnowledgeLease {
  owner: string;
  taskId: string;
  generation: number;
  token: string;
}

export interface KnowledgeExecution extends KnowledgeLease {
  sessionId: string;
  runId: string;
}

export interface KnowledgeTaskRow extends KnowledgeTask {
  owner: string;
  signature: string;
  failures: number;
  outputAttempts: number;
  nextOutputAt: number;
  inputDigest: string;
  dialogueDigest: string;
  draftDigest: string | null;
  outputDigest: string | null;
  leaseUntil: number | null;
  token: string | null;
  sessionId: string | null;
  runId: string | null;
  autoEligible: number;
}

export interface KnowledgeTaskReads {
  get(owner: string, id: string): KnowledgeTaskRow;
  list(owner: string, project: string, limit?: number): KnowledgeTaskRow[];
  page(
    owner: string,
    project: string,
    position?: KnowledgeTaskPosition,
    limit?: number,
  ): { tasks: KnowledgeTaskRow[]; next: KnowledgeTaskPosition | null };
  submission(owner: string, operationId: string, requestHash: string): KnowledgeTaskRow | null;
}
export interface KnowledgeTaskPosition {
  createdAt: number;
  id: string;
  watermark: { rowid: number; id: string };
}
export interface KnowledgeSubmission {
  owner: string;
  project: string;
  title: string;
  operationId: string;
  requestHash: string;
  signature: string;
  inputDigest: string;
  dialogueDigest: string;
  autoEligible?: boolean;
}
export interface KnowledgeTaskSubmissions {
  create(input: KnowledgeSubmission, now: number, guard?: KnowledgeSubmissionGuard): KnowledgeTaskRow;
}
/** Internal metadata admission runs inside the task insertion transaction, including operation replays. */
export type KnowledgeSubmissionGuard = (taskId: string, created: boolean, now: number) => void | Promise<void>;
export interface KnowledgeSubmissionAdmission {
  source: { id: string; version: string; kind?: SavedSourceKind };
  commit: KnowledgeSubmissionGuard;
  withSource<T>(commit: string, create: (assertHeld: () => void) => T): Promise<T>;
}
export interface KnowledgeExecutionTasks {
  claim(now: number, leaseMs: number): { task: KnowledgeTaskRow; lease: KnowledgeLease } | null;
  assertLease(lease: KnowledgeLease, now: number): KnowledgeTaskRow;
  assertExecution(scope: KnowledgeExecution, now: number): KnowledgeTaskRow;
  bind(lease: KnowledgeLease, scope: { sessionId: string; runId: string }, now: number): KnowledgeExecution;
  heartbeat(lease: KnowledgeLease, now: number, leaseMs: number): void;
  fail(lease: KnowledgeLease, failure: KnowledgeFailure, now: number): boolean;
  release(lease: KnowledgeLease, now: number): void;
  retry(owner: string, id: string, now: number): KnowledgeTaskRow;
}
export interface KnowledgeReviewTasks {
  question(scope: KnowledgeExecution, dialogueDigest: string, now: number): KnowledgeTaskRow;
  draft(scope: KnowledgeExecution, draftDigest: string, now: number): KnowledgeTaskRow;
  answer(owner: string, id: string, previous: string, dialogueDigest: string, now: number): KnowledgeTaskRow;
  edit(owner: string, id: string, revision: number, digest: string, now: number): KnowledgeTaskRow;
  admit(owner: string, id: string, revision: number, outputDigest: string, now: number): KnowledgeTaskRow;
  cancel(owner: string, id: string, now: number): KnowledgeTaskRow;
}
export interface KnowledgeDeliveryTasks {
  /** Only a receipt-absence check under the file lease may cancel an unwritten admitted output. */
  denyDelivery(owner: string, id: string, digest: string, now: number): void;
  complete(
    owner: string,
    id: string,
    digest: string,
    receipt: KnowledgeReceipt,
    now: number,
    projection?: KnowledgeCatalogProjection,
  ): KnowledgeTaskRow;
  outputFailed(owner: string, id: string, digest: string, now: number): void;
  retryOutput(owner: string, id: string, now: number): KnowledgeTaskRow;
  nextOutput(now?: number): KnowledgeTaskRow | null;
  rejectDelivery(
    owner: string,
    id: string,
    digest: string,
    reason: "sourceChanged" | "targetChanged",
    now: number,
  ): void;
}
/** Composition joins storage facets; each use case receives only the facet it needs. */
export interface KnowledgeTaskStore
  extends
    KnowledgeTaskReads,
    KnowledgeTaskSubmissions,
    KnowledgeExecutionTasks,
    KnowledgeReviewTasks,
    KnowledgeDeliveryTasks {}

/** Immutable source snapshots and drafts live in files, never in the execution ledger. */
export interface KnowledgeTaskFiles {
  input(digest: string): Promise<KnowledgeTaskInput>;
  dialogue(digest: string): Promise<KnowledgeDialogue>;
  draft(digest: string): Promise<KnowledgeDraftInput>;
  output(digest: string): Promise<KnowledgeRecord>;
  putInput(value: KnowledgeTaskInput): Promise<string>;
  putDialogue(value: KnowledgeDialogue): Promise<string>;
  putDraft(value: KnowledgeDraftInput): Promise<string>;
  putOutput(value: KnowledgeRecord): Promise<string>;
  review(digest: string): Promise<KnowledgeReviewReport>;
  putReview(value: KnowledgeReviewReport): Promise<string>;
  previous(digest: string): Promise<KnowledgePrevious>;
  putPrevious(value: KnowledgePrevious): Promise<string>;
}

export interface KnowledgeContent {
  authorize(owner: string, project: string): Promise<void>;
  capture(
    owner: string,
    selection: KnowledgeSelection,
  ): Promise<{
    commit: string;
    sources: KnowledgeTaskInput["sources"];
    target: KnowledgeTaskInput["target"];
    identities?: { id: string; version: string }[];
    previous?: KnowledgePrevious;
  }>;
  /** This check is repeated under the same file/Git write lease that commits the approved result. */
  current(owner: string, input: KnowledgeTaskInput): Promise<boolean>;
  save(
    owner: string,
    input: KnowledgeTaskInput,
    record: KnowledgeRecord,
    assertAdmitted?: () => void | Promise<void>,
  ): Promise<KnowledgeReceipt>;
  /** Internal receipt recovery never creates content or returns source bodies. Missing runs under the same file lease as writers. */
  recover?(
    owner: string,
    input: KnowledgeTaskInput,
    record: KnowledgeRecord,
    missing?: () => Promise<void>,
  ): Promise<{ receipt: KnowledgeReceipt; projection: KnowledgeCatalogProjection } | null>;
  projection?(
    owner: string,
    input: KnowledgeTaskInput,
    record: KnowledgeRecord,
    receipt: KnowledgeReceipt,
  ): Promise<KnowledgeCatalogProjection>;
}

export class KnowledgeTaskError extends Error {
  constructor(
    readonly code: "invalidInput" | "contextLimit" | "notFound" | "conflict" | "leaseLost" | "budget" | "unavailable",
    readonly status = code === "notFound"
      ? 404
      : ["invalidInput", "contextLimit"].includes(code)
        ? 400
        : code === "unavailable"
          ? 503
          : 409,
  ) {
    super(code);
  }
}

/** Adapters may raise this only before writing, after replaying any existing successful operation receipt. */
export class KnowledgeWriteConflict extends KnowledgeTaskError {
  constructor(readonly reason: "sourceChanged" | "targetChanged") {
    super("conflict");
  }
}
