import type { JsonValue, WorkflowStep } from "../../../../shared/delivery/workflow.js";
import type { AwaitableWorkflowEffects } from "../../workflows/async-ports.js";
import { RemoteOperationError } from "../../workflows/errors.js";
function belongs(step: WorkflowStep, key: string) {
  return step.key === key || (step.key.startsWith(`${key}.g`) && /^[1-9][0-9]*$/.test(step.key.slice(key.length + 2)));
}
export async function acknowledgedOperation(
  effects: AwaitableWorkflowEffects,
  key: string,
): Promise<WorkflowStep | undefined> {
  const steps = (await effects.inspect()).steps.filter((step) => belongs(step, key)),
    latest = steps.at(-1);
  if (latest?.outcome === "pending") throw new RemoteOperationError("outcomeUnknown", "unknown");
  if (latest?.outcome !== "succeeded") return;
  const byKey = new Map(steps.map((step) => [step.key, step]));
  for (const step of byKey.values())
    if (step.outcome === "rejected" && step.replacedBy === null) await effects.replaceRejected(step.key, latest.key);
  return latest;
}
/** A changed media binding can replace a rejected request, never an unresolved or successful one. */
export async function confirmedOperation(
  effects: AwaitableWorkflowEffects,
  key: string,
  operation: string,
  request: JsonValue,
  dispatch: () => Promise<JsonValue>,
) {
  const complete = await acknowledgedOperation(effects, key);
  if (complete) return complete.result;
  const previous = (await effects.inspect()).steps.filter((step) => belongs(step, key)).at(-1);
  const next = previous ? `${key}.g${(await effects.inspect()).confirmation}` : key;
  const result = await effects.run(next, operation, request, dispatch);
  await acknowledgedOperation(effects, key);
  return result;
}
