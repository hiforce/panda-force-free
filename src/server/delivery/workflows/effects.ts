import type { JsonValue, WorkflowPlan } from "../../../shared/delivery/workflow.js";
import type { PublicationLease } from "../storage/leases.js";
import type { WorkflowRepository } from "../storage/workflows.js";
import type { WorkflowEffects, WorkflowHandler } from "./ports.js";
import { RemoteOperationError, WorkflowDeferred } from "./errors.js";

/** Fences new effects; settlement remains possible after an operator requests a stop. */
export function workflowEffects(
  store: WorkflowRepository,
  handler: WorkflowHandler,
  owner: string,
  plan: WorkflowPlan,
  lease: PublicationLease,
  initialAuthorization: () => void,
): WorkflowEffects {
  let authorization = initialAuthorization;
  const guard = <T>(operation: () => T) =>
    store.leases.guard(lease, () => {
      store.cancellations.assertContinuing(lease.id);
      authorization();
      return operation();
    });
  return {
    inspect: () =>
      guard(() => {
        const record = store.get(lease.id);
        return {
          steps: store.steps.effective(lease.id),
          observations: [
            ...new Map(
              [...record.lineage.observations, ...record.observations].map((item) => [item.key, item]),
            ).values(),
          ],
          confirmation: record.lineage.confirmations + record.confirmations.length,
        };
      }),
    observe: (key, request, result) => guard(() => store.observations.record(lease, key, request, result)),
    wait: (until) => {
      throw new WorkflowDeferred(until);
    },
    replaceRejected: (before, after) => guard(() => store.steps.replaceRejected(lease, before, after)),
    run: async (key, operation, input, dispatch): Promise<JsonValue> => {
      // File/source reads finish before the lease transaction. A synchronous guard fences the actual intent.
      authorization = await handler.authorize(owner, plan);
      const { step, send } = guard(() => store.steps.intent(lease, key, operation, input));
      if (!send) {
        if (step.outcome === "succeeded") return step.result;
        throw new RemoteOperationError(
          step.error || "outcomeUnknown",
          step.outcome === "pending" ? "unknown" : "rejected",
        );
      }
      let result: JsonValue;
      try {
        // An intent is already in flight. Preserve its response even if future dispatch is now stopped.
        result = await dispatch();
      } catch (error) {
        if (error instanceof RemoteOperationError && error.outcome === "rejected")
          store.steps.settle(lease, step.id, "rejected", null, error.code);
        throw error;
      }
      store.steps.settle(lease, step.id, "succeeded", result, null);
      return result;
    },
  };
}
