import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import type { WorkflowPlan, WorkflowRecord } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import { workflowJson } from "./json.js";
import { mysqlWorkflowSuccessor } from "./mysql-workflow-lineage-read.js";
type PlanInput = Omit<WorkflowPlan, "kind" | "fingerprint" | "createdAt" | "expiresAt">;
/** Seals one predecessor and creates one reviewed successor without copying transport receipts. */
export class MySQLWorkflowLineageRepository {
  constructor(
    private db: MySQLSession,
    private owned: (
      owner: string,
      id: string,
    ) => (WorkflowRecord | Promise<WorkflowRecord>) | Promise<Awaited<WorkflowRecord | Promise<WorkflowRecord>>>,
    private prepare: (
      owner: string,
      identity: string,
      input: PlanInput,
    ) => (WorkflowRecord | Promise<WorkflowRecord>) | Promise<Awaited<WorkflowRecord | Promise<WorkflowRecord>>>,
    private now = Date.now,
  ) {}
  async create(
    owner: string,
    parentId: string,
    stateToken: string,
    input: PlanInput,
    authorize: (parent: WorkflowRecord) => void | Promise<Awaited<void>>,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const parent = await this.owned(owner, parentId);
        await authorize(parent);
        const existing = await mysqlWorkflowSuccessor(this.db, parentId);
        if (existing) {
          const child = await this.owned(owner, existing);
          if (digest(workflowJson({ ...input, id: child.plan.id }, 1024 * 1024)) !== child.plan.fingerprint)
            throw new DeliveryError("planSuperseded", 409);
          return child;
        }
        if (parent.continuationToken !== stateToken) throw new DeliveryError("recoveryChanged", 409);
        const lease = (await this.db.one<{
          leaseUntil: number;
        }>("SELECT leaseUntil FROM panda_force_publication_jobs WHERE id=?", [parentId]))!;
        if (
          lease.leaseUntil > this.now() ||
          !["prepared", "failed", "cancelled", "needsAttention"].includes(parent.phase)
        )
          throw new DeliveryError("recoveryBusy", 409);
        if (resolvedWorkflowSteps(parent.steps, parent.resolutions).some((step) => step.outcome === "pending"))
          throw new DeliveryError("outcomeUnknown", 409);
        if (parent.lineage.depth >= 16) throw new DeliveryError("historyFull", 507);
        if (
          input.id === parentId ||
          input.projectId !== parent.plan.projectId ||
          input.sourceProjectId !== parent.plan.sourceProjectId ||
          input.spaceId !== parent.plan.spaceId ||
          input.connectionId !== parent.plan.connectionId
        )
          throw new DeliveryError("invalidInput");
        if (await this.db.one("SELECT id FROM panda_force_publication_plans WHERE id=?", [input.id]))
          throw new DeliveryError("conflict", 409);
        const identity = (await this.db.one<{
          identity: string | null;
        }>("SELECT identity FROM panda_force_publication_plans WHERE id=?", [parentId]))!.identity;
        if (!identity) throw new DeliveryError("planSuperseded", 409);
        await this.db.execute("UPDATE panda_force_publication_plans SET identity=NULL WHERE id=?", [parentId]);
        const child = await this.prepare(owner, identity, input);
        await this.db.execute(
          "INSERT INTO panda_force_publication_successors(parentId,childId,actor,createdAt,fingerprint,stateToken) VALUES(?,?,?,?,?,?)",
          [parentId, child.plan.id, owner, this.now(), parent.plan.fingerprint, stateToken],
        );
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET leaseFence=leaseFence+1,leaseUntil=0 WHERE id=?",
          [parentId],
        );
        return await this.owned(owner, child.plan.id);
      });
    });
  }
}
