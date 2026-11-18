import type { CreationProgress } from "../../shared/creation/contracts.js";
import type {
  CreationArtifact,
  CreationExecution,
  CreationFailure,
  CreationLease,
  CreationTask,
  CreationTaskSpec,
} from "./contracts.js";

export type CreationResult<T> = T | Promise<T>;

/** Task metadata contains hashes and references; document source stays in files. */
export interface CreationOutputTasks {
  get(owner: string, id: string): CreationResult<CreationTask>;
  assertExecution(scope: CreationExecution, now: number): CreationResult<CreationTask>;
  admit(scope: CreationExecution, digest: string, now: number): CreationResult<CreationTask>;
  complete(
    owner: string,
    id: string,
    digest: string,
    artifact: CreationArtifact,
    now: number,
  ): CreationResult<CreationTask>;
  outputFailure(owner: string, id: string, digest: string, failure: CreationFailure, now: number): CreationResult<void>;
}
export interface CreationOutputContent {
  /** Validation and durable staging finish before application authority admits an output. */
  stage(value: unknown, task?: import("./contracts.js").CreationTaskSpec): Promise<string>;
}
export interface CreationExecutionTasks {
  get(owner: string, id: string): CreationResult<CreationTask>;
  bind(lease: CreationLease, sessionId: string, runId: string, now: number): CreationResult<CreationExecution>;
}
export interface CreationArtifactWriter {
  /** Repeating an admitted operation must return its real receipt without modifying the saved artifact. */
  commit(task: CreationTaskSpec, outputDigest: string): Promise<CreationArtifact>;
}

export interface CreationProgressStore {
  record(lease: CreationLease, event: CreationProgress): void | Promise<void>;
  list(owner: string, id: string, conversation?: boolean): CreationProgress[] | Promise<CreationProgress[]>;
}

/** A continuation freezes the real current source and updates that document through a durable revision receipt. */
export interface CreationDocumentRevisions {
  read(
    owner: string,
    projectId: string,
    documentId: string,
  ): Promise<{
    projectId?: string;
    treeVersion?: number;
    base: import("../../shared/documents/contracts.js").DocumentRevisionReference;
    document: { title: string; body: import("../../shared/documents/rich-body.js").RichDocumentBody };
  }>;
  save(
    task: import("./contracts.js").CreationTaskSpec,
    digest: string,
    body: import("../../shared/documents/rich-body.js").RichDocumentBody,
  ): Promise<import("../../shared/creation/contracts.js").CreationDocumentArtifact>;
}
