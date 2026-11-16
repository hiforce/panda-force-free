import type { JsonValue, WorkflowPlan, WorkflowStep, WorkflowObservation } from "../../../shared/delivery/workflow.js";

export interface WorkflowEffects {
  /** Each key identifies one immutable remote operation, including its exact request digest. */
  run(key: string, operation: string, request: JsonValue, dispatch: () => Promise<JsonValue>): Promise<JsonValue>;
  inspect(): { steps: WorkflowStep[]; observations: WorkflowObservation[]; confirmation: number };
  observe(key: string, request: JsonValue, result: JsonValue): void;
  wait(until: number): never;
  replaceRejected(rejectedKey: string, replacementKey: string): void;
}

export interface WorkflowHandler {
  authorize(owner: string, plan: WorkflowPlan): (() => void) | Promise<() => void>;
  execute(owner: string, plan: WorkflowPlan, effects: WorkflowEffects): Promise<JsonValue>;
}
