import type { WorkflowPlan } from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";
import { workflowJson } from "./json.js";

/** Missing source scope retains the exact legacy fingerprint. File scope is part of immutable identity. */
export function workflowPlanInput(
  plan: Pick<WorkflowPlan, "id" | "projectId" | "spaceId" | "connectionId" | "payload" | "sourceProjectId">,
) {
  return {
    id: plan.id,
    projectId: plan.projectId,
    spaceId: plan.spaceId,
    connectionId: plan.connectionId,
    payload: plan.payload,
    ...(plan.sourceProjectId === undefined ? {} : { sourceProjectId: plan.sourceProjectId }),
  };
}
export function readWorkflowPlan(record: string, request: string, id: string, kind: string): WorkflowPlan {
  const plan = JSON.parse(record) as WorkflowPlan;
  if (
    plan.id !== id ||
    plan.kind !== kind ||
    plan.fingerprint !== request ||
    (plan.sourceProjectId !== undefined &&
      (plan.sourceProjectId !== plan.projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(plan.sourceProjectId))) ||
    digest(workflowJson(workflowPlanInput(plan), 1024 * 1024)) !== plan.fingerprint
  )
    throw new DeliveryError("invalidSnapshot", 409);
  return plan;
}
