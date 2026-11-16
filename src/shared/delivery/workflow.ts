export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface WorkflowPlan {
  id: string;
  kind: string;
  projectId: string;
  sourceProjectId?: string;
  spaceId: string;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  payload: JsonValue;
}
export type WorkflowPhase =
  "prepared" | "queued" | "running" | "waiting" | "completed" | "failed" | "needsAttention" | "cancelled";
export interface WorkflowStep {
  id: number;
  key: string;
  operation: string;
  attempt: number;
  outcome: "pending" | "succeeded" | "rejected";
  requestHash: string;
  result: JsonValue;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  replacedBy: number | null;
}
export interface WorkflowRecord {
  plan: WorkflowPlan;
  phase: WorkflowPhase;
  error: string | null;
  updatedAt: number;
  receipt: JsonValue;
  steps: WorkflowStep[];
  confirmations: WorkflowConfirmation[];
  observations: WorkflowObservation[];
  nextRunAt: number | null;
  cancellation: WorkflowCancellation | null;
  recoveryEvidence: WorkflowRecoveryEvidence[];
  resolutions: WorkflowResolution[];
  lineage: WorkflowLineage;
  continuationToken: string;
}
/** Stops future dispatch while preserving the outcome of operations already in flight. */
export interface WorkflowCancellation {
  actor: string;
  requestedAt: number;
}
/** Read-only provider observations do not authorize or acknowledge remote mutations. */
export interface WorkflowObservation {
  key: string;
  requestHash: string;
  result: JsonValue;
  observedAt: number;
}
export interface WorkflowConfirmation {
  actor: string;
  fingerprint: string;
  createdAt: number;
  resume: boolean;
  details: JsonValue;
}

/** A lookup is evidence, never an acknowledgement of the original remote request. */
export interface WorkflowRecoveryReport {
  status: "match" | "mismatch" | "unavailable";
  result: JsonValue;
  details: JsonValue;
}
export interface WorkflowRecoveryEvidence extends WorkflowRecoveryReport {
  id: string;
  stepId: number;
  actor: string;
  fingerprint: string;
  requestHash: string;
  stateToken: string;
  observedAt: number;
  expiresAt: number;
}
/** The operator adopts an existing result; the original pending intent stays unchanged. */
export interface WorkflowResolution {
  stepId: number;
  evidenceId: string;
  actor: string;
  decidedAt: number;
  decision: "adopt-existing";
  result: JsonValue;
}

/** Successful ancestor effects are references with their original acknowledgement source. */
export interface WorkflowInheritedStep extends WorkflowStep {
  sourceJobId: string;
  resolution: WorkflowResolution | null;
}
export interface WorkflowLineage {
  predecessorId: string | null;
  successorId: string | null;
  rootId: string;
  depth: number;
  confirmations: number;
  steps: WorkflowInheritedStep[];
  observations: WorkflowObservation[];
}
