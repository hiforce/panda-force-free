import type { JsonValue, WorkflowPlan } from "../../../shared/delivery/workflow.js";
import type { PublicationLease } from "../storage/mysql-leases.js";
import type { MySQLWorkflowRepository } from "../storage/mysql-workflows.js";
import type { AsyncWorkflowHandler, AwaitableWorkflowEffects } from "./async-ports.js";
import { RemoteOperationError, WorkflowDeferred } from "./errors.js";
/** Fences new effects; settlement remains possible after an operator requests a stop. */
export function mysqlWorkflowEffects(
  store: MySQLWorkflowRepository,
  handler: AsyncWorkflowHandler,
  owner: string,
  plan: WorkflowPlan,
  lease: PublicationLease,
  initialAuthorization: () => void | Promise<void>,
): AwaitableWorkflowEffects {
  let authorization = initialAuthorization;
  const guard = async <T>(operation: () => T) =>
    await store.leases.guard(lease, async () => {
      await store.cancellations.assertContinuing(lease.id);
      await authorization();
      return operation();
    });
  return {
    inspect: async () =>
      await guard(async () => {
        const record = await store.get(lease.id);
        return {
          steps: await store.steps.effective(lease.id),
          observations: [
            ...new Map(
              [...record.lineage.observations, ...record.observations].map((item) => [item.key, item]),
            ).values(),
          ],
          confirmation: record.lineage.confirmations + record.confirmations.length,
        };
      }),
    observe: async (key, request, result) =>
      await guard(async () => await store.observations.record(lease, key, request, result)),
    wait: (until) => {
      throw new WorkflowDeferred(until);
    },
    replaceRejected: async (before, after) =>
      await guard(async () => await store.steps.replaceRejected(lease, before, after)),
    run: async (key, operation, input, dispatch): Promise<JsonValue> => {
      // File/source reads finish before the lease transaction. The native transaction awaits the final ownership guard before recording intent.
      authorization = await handler.authorize(owner, plan);
      const { step, send } = await guard(async () => await store.steps.intent(lease, key, operation, input));
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
          await store.steps.settle(lease, step.id, "rejected", null, error.code);
        throw error;
      }
      await store.steps.settle(lease, step.id, "succeeded", result, null);
      return result;
    },
  };
}
