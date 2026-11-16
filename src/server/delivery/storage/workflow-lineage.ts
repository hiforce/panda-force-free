import type { Database } from "bun:sqlite";
import type { WorkflowPlan, WorkflowRecord } from "../../../shared/delivery/workflow.js";
import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import { workflowSuccessor } from "./workflow-lineage-read.js";
import { workflowJson } from "./json.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";

type PlanInput = Omit<WorkflowPlan, "kind" | "fingerprint" | "createdAt" | "expiresAt">;
/** Seals one predecessor and creates one reviewed successor without copying transport receipts. */
export class WorkflowLineageRepository {
  constructor(
    private db: Database,
    private owned: (owner: string, id: string) => WorkflowRecord,
    private prepare: (owner: string, identity: string, input: PlanInput) => WorkflowRecord,
    private now = Date.now,
  ) {}
  create(
    owner: string,
    parentId: string,
    stateToken: string,
    input: PlanInput,
    authorize: (parent: WorkflowRecord) => void,
  ) {
    return this.db
      .transaction(() => {
        const parent = this.owned(owner, parentId);
        authorize(parent);
        const existing = workflowSuccessor(this.db, parentId);
        if (existing) {
          const child = this.owned(owner, existing);
          if (digest(workflowJson({ ...input, id: child.plan.id }, 1024 * 1024)) !== child.plan.fingerprint)
            throw new DeliveryError("planSuperseded", 409);
          return child;
        }
        if (parent.continuationToken !== stateToken) throw new DeliveryError("recoveryChanged", 409);
        const lease = this.db
          .query<{ leaseUntil: number }, [string]>("SELECT leaseUntil FROM publication_jobs WHERE id=?")
          .get(parentId)!;
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
        if (this.db.query("SELECT id FROM publication_plans WHERE id=?").get(input.id))
          throw new DeliveryError("conflict", 409);
        const identity = this.db
          .query<{ identity: string | null }, [string]>("SELECT identity FROM publication_plans WHERE id=?")
          .get(parentId)!.identity;
        if (!identity) throw new DeliveryError("planSuperseded", 409);
        this.db.query("UPDATE publication_plans SET identity=NULL WHERE id=?").run(parentId);
        const child = this.prepare(owner, identity, input);
        this.db
          .query(
            "INSERT INTO publication_successors(parentId,childId,actor,createdAt,fingerprint,stateToken) VALUES(?,?,?,?,?,?)",
          )
          .run(parentId, child.plan.id, owner, this.now(), parent.plan.fingerprint, stateToken);
        this.db.query("UPDATE publication_jobs SET leaseFence=leaseFence+1,leaseUntil=0 WHERE id=?").run(parentId);
        return this.owned(owner, child.plan.id);
      })
      .immediate();
  }
}
