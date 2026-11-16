import type { ReadQueries } from "../../../shared/storage/read-queries.js";
import type { WorkflowLineage, WorkflowObservation } from "../../../shared/delivery/workflow.js";
import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import { readWorkflowSteps } from "./workflow-step-read.js";
import { readWorkflowPlan } from "./workflow-plan-read.js";
import { workflowResolutions } from "./workflow-resolutions.js";
import { DeliveryError } from "../errors.js";

export function workflowSuccessor(db: ReadQueries, job: string) {
  return (
    db.query<{ childId: string }, [string]>("SELECT childId FROM publication_successors WHERE parentId=?").get(job)
      ?.childId || null
  );
}
export function assertWorkflowUnsealed(db: ReadQueries, job: string) {
  if (workflowSuccessor(db, job)) throw new DeliveryError("planSuperseded", 409);
}

/** Ancestor effects remain in their original rows; this read model exposes their provenance. */
export function readWorkflowLineage(db: ReadQueries, job: string): WorkflowLineage {
  const ancestors: string[] = [],
    seen = new Set([job]);
  let current = job;
  while (true) {
    const link = db
      .query<{ parentId: string; fingerprint: string }, [string]>(
        "SELECT parentId,fingerprint FROM publication_successors WHERE childId=?",
      )
      .get(current);
    if (!link) break;
    if (seen.has(link.parentId) || ancestors.length >= 16) throw new DeliveryError("invalidSnapshot", 409);
    const row = db
      .query<
        {
          record: string;
          request: string;
          kind: string;
          ownerId: string;
          childOwner: string;
          childKind: string;
          childRecord: string;
          childRequest: string;
        },
        [string, string]
      >(
        "SELECT p.record,p.request,p.kind,p.ownerId,c.ownerId AS childOwner,c.kind AS childKind,c.record AS childRecord,c.request AS childRequest FROM publication_plans p JOIN publication_plans c ON c.id=? WHERE p.id=?",
      )
      .get(current, link.parentId);
    if (!row || row.ownerId !== row.childOwner || row.kind !== row.childKind || row.request !== link.fingerprint)
      throw new DeliveryError("invalidSnapshot", 409);
    const parentPlan = readWorkflowPlan(row.record, row.request, link.parentId, row.kind),
      childPlan = readWorkflowPlan(row.childRecord, row.childRequest, current, row.childKind);
    if (
      parentPlan.projectId !== childPlan.projectId ||
      parentPlan.spaceId !== childPlan.spaceId ||
      parentPlan.connectionId !== childPlan.connectionId
    )
      throw new DeliveryError("invalidSnapshot", 409);
    ancestors.push(link.parentId);
    seen.add(link.parentId);
    current = link.parentId;
  }
  const lineage: WorkflowLineage = {
    predecessorId: ancestors[0] || null,
    successorId: workflowSuccessor(db, job),
    rootId: ancestors.at(-1) || job,
    depth: ancestors.length,
    confirmations: 0,
    steps: [],
    observations: [],
  };
  const observations = new Map<string, WorkflowObservation>();
  for (const parent of ancestors.reverse()) {
    const resolutions = workflowResolutions(db, parent),
      steps = resolvedWorkflowSteps(readWorkflowSteps(db, parent), resolutions);
    if (steps.some((step) => step.outcome === "pending")) throw new DeliveryError("outcomeUnknown", 409);
    lineage.steps.push(
      ...steps
        .filter((step) => step.outcome === "succeeded")
        .map((step) => ({
          ...step,
          sourceJobId: parent,
          resolution: resolutions.find((item) => item.stepId === step.id) || null,
        })),
    );
    lineage.confirmations += db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM publication_confirmations WHERE jobId=?")
      .get(parent)!.n;
    for (const row of db
      .query<Omit<WorkflowObservation, "result"> & { result: string }, [string]>(
        "SELECT observationKey AS key,requestHash,result,observedAt FROM publication_observations WHERE jobId=?",
      )
      .all(parent))
      observations.set(row.key, { ...row, result: JSON.parse(row.result) });
    if (lineage.steps.length > 2048 || observations.size > 1024) throw new DeliveryError("historyFull", 507);
  }
  lineage.steps.sort((a, b) => a.id - b.id);
  lineage.observations = [...observations.values()];
  return lineage;
}
