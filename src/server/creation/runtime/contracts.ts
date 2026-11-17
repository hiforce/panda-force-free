import type { CreationResult } from "../ports.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import type { CreationEngineProfile } from "../input.js";
import type { CreationFailure, CreationLease, CreationTask } from "../contracts.js";
import type { CreationExecutionTasks } from "../ports.js";

export interface CreationClaim {
  lease: CreationLease;
  task: CreationTask;
}
export interface CreationScheduling {
  claim(now: number, leaseMs?: number): CreationResult<CreationClaim | null>;
  release(lease: CreationLease, now: number): CreationResult<boolean>;
  fail(lease: CreationLease, failure: CreationFailure, now: number): CreationResult<boolean>;
  nextOutput(now: number): CreationResult<CreationTask | null>;
}
export interface CreationRunTasks extends CreationExecutionTasks {
  assertExecution(scope: import("../contracts.js").CreationExecution, now: number): CreationResult<CreationTask>;
  heartbeat(lease: CreationLease, now: number, leaseMs: number): CreationResult<void>;
}
export interface CreationEngines {
  select(profile: CreationEngineProfile): ApplicationToolEngine;
}
export interface CreationRunPermit {
  suspend(): void;
  resume(signal: AbortSignal): Promise<void>;
  close(): void;
}
