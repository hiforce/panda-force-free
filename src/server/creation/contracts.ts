import type { CreationArtifact, CreationFailure, CreationTaskState } from "../../shared/creation/contracts.js";
export type {
  CreationArtifact,
  CreationDocumentArtifact,
  CreationFailure,
  CreationTaskState,
} from "../../shared/creation/contracts.js";
/** Application-owned output identity is independent of a model call or engine request ID. */
export interface CreationTaskSpec {
  schema: 1;
  id: string;
  owner: string;
  projectId: string;
  operationId: string;
  kind: import("../../shared/creation/contracts.js").CreationRequestedOutput;
  target: {
    parentId: string | null;
    treeVersion: number;
    locale: string;
    document?: import("../../shared/documents/contracts.js").DocumentRevisionReference;
    documentProjectId?: string;
  };
  inputDigest: string;
  skillCaptureId: string | null;
  previousTaskId?: string;
  /** Immutable application-owned lineage key; legacy rows are derived without rewriting their receipts. */
  creationKey?: string;
}
export interface CreationTask {
  spec: CreationTaskSpec;
  state: CreationTaskState;
  generation: number;
  attempts: number;
  cancelRequested: boolean;
  outputDigest: string | null;
  artifact: CreationArtifact | null;
  failure: CreationFailure | null;
  createdAt: number;
  updatedAt: number;
}
export interface CreationLease {
  taskId: string;
  owner: string;
  generation: number;
  token: string;
}
/** The engine adapter adds session and run identity only after its start acknowledgements. */
export interface CreationExecution extends CreationLease {
  sessionId: string;
  runId: string;
  contextVersion?: string;
  goalVersion?: number;
}
export class CreationError extends Error {
  constructor(
    readonly code:
      | "invalidInput"
      | "notFound"
      | "conflict"
      | "leaseLost"
      | "unavailable"
      | "invalidOutput"
      | "defaultWorkflowMissing",
  ) {
    super(code);
    this.name = "CreationError";
  }
}
/** Artifact adapters classify write failures without exposing storage exceptions to an engine or browser. */
export class CreationWriteError extends Error {
  constructor(
    readonly failure: CreationFailure,
    cause: unknown,
  ) {
    super(failure, { cause });
    this.name = "CreationWriteError";
  }
}
