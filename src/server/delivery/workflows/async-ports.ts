import type { AwaitableStore } from "../../../shared/async-store.js";
import type { JsonValue, WorkflowPlan } from "../../../shared/delivery/workflow.js";
import type { WorkflowEffects } from "./ports.js";
/** Existing direct effects and native async effects retain the same confirmation, observation and irreversible-operation semantics. */
export type AwaitableWorkflowEffects = Omit<WorkflowEffects, "inspect" | "observe" | "replaceRejected"> &
  AwaitableStore<Pick<WorkflowEffects, "inspect" | "observe" | "replaceRejected">>;
export interface AsyncWorkflowHandler {
  authorize(owner: string, plan: WorkflowPlan): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
  execute(owner: string, plan: WorkflowPlan, effects: AwaitableWorkflowEffects): Promise<JsonValue>;
}
