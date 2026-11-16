import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import type { WorkflowLineage, WorkflowObservation } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { DeliveryError } from "../errors.js";
import { mysqlWorkflowResolutions } from "./mysql-workflow-resolutions.js";
import { mysqlReadWorkflowSteps } from "./mysql-workflow-step-read.js";
import { readWorkflowPlan } from "./workflow-plan-read.js";
export async function mysqlWorkflowSuccessor(db: MySQLSession, job: string) {
  return (
    (
      await db.one<{
        childId: string;
      }>("SELECT childId FROM panda_force_publication_successors WHERE parentId=?", [job])
    )?.childId || null
  );
}
export async function mysqlAssertWorkflowUnsealed(db: MySQLSession, job: string) {
  if (await mysqlWorkflowSuccessor(db, job)) throw new DeliveryError("planSuperseded", 409);
}
/** Ancestor effects remain in their original rows; this read model exposes their provenance. */
export async function mysqlReadWorkflowLineage(db: MySQLSession, job: string): Promise<WorkflowLineage> {
  const ancestors: string[] = [],
    seen = new Set([job]);
  let current = job;
  while (true) {
    const link = await db.one<{
      parentId: string;
      fingerprint: string;
    }>("SELECT parentId,fingerprint FROM panda_force_publication_successors WHERE childId=?", [current]);
    if (!link) break;
    if (seen.has(link.parentId) || ancestors.length >= 16) throw new DeliveryError("invalidSnapshot", 409);
    const row = await db.one<{
      record: string;
      request: string;
      kind: string;
      ownerId: string;
      childOwner: string;
      childKind: string;
      childRecord: string;
      childRequest: string;
    }>(
      "SELECT p.record,p.request,p.kind,p.ownerId,c.ownerId AS childOwner,c.kind AS childKind,c.record AS childRecord,c.request AS childRequest FROM panda_force_publication_plans p JOIN panda_force_publication_plans c ON c.id=? WHERE p.id=?",
      [current, link.parentId],
    );
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
    successorId: await mysqlWorkflowSuccessor(db, job),
    rootId: ancestors.at(-1) || job,
    depth: ancestors.length,
    confirmations: 0,
    steps: [],
    observations: [],
  };
  const observations = new Map<string, WorkflowObservation>();
  for (const parent of ancestors.reverse()) {
    const resolutions = await mysqlWorkflowResolutions(db, parent),
      steps = resolvedWorkflowSteps(await mysqlReadWorkflowSteps(db, parent), resolutions);
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
    lineage.confirmations += (await db.one<{
      n: number;
    }>("SELECT count(*) AS n FROM panda_force_publication_confirmations WHERE jobId=?", [parent]))!.n;
    for (const row of await db.all<
      Omit<WorkflowObservation, "result"> & {
        result: string;
      }
    >(
      "SELECT observationKey AS `key`,requestHash,result,observedAt FROM panda_force_publication_observations WHERE jobId=?",
      [parent],
    ))
      observations.set(row.key, { ...row, result: JSON.parse(row.result) });
    if (lineage.steps.length > 2048 || observations.size > 1024) throw new DeliveryError("historyFull", 507);
  }
  lineage.steps.sort((a, b) => a.id - b.id);
  lineage.observations = [...observations.values()];
  return lineage;
}
