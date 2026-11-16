import { readWorkflowLineage } from "../../delivery/storage/workflow-lineage-read.js";
import { LegacyHistoryContext, historyJson, invalidHistory } from "./context.js";

function resolutions(c: LegacyHistoryContext, id: string): Set<number> {
  const resolved = new Set<number>(),
    plan = c.plans.get(id)!;
  for (const row of c.db
    .query<{ stepId: number; evidenceId: string; actor: string; decidedAt: number; decision: string }, [string]>(
      "SELECT r.* FROM publication_resolutions r JOIN publication_steps s ON s.id=r.stepId WHERE s.jobId=? ORDER BY r.stepId",
    )
    .iterate(id)) {
    const evidence = c.db
        .query<
          {
            jobId: string;
            stepId: number;
            actor: string;
            fingerprint: string;
            requestHash: string;
            expiresAt: number;
            status: string;
            result: string;
          },
          [string]
        >("SELECT * FROM publication_recovery_evidence WHERE id=?")
        .get(row.evidenceId),
      step = c.db
        .query<{ jobId: string; requestHash: string; outcome: string }, [number]>(
          "SELECT jobId,requestHash,outcome FROM publication_steps WHERE id=?",
        )
        .get(row.stepId);
    if (
      !evidence ||
      !step ||
      step.outcome !== "pending" ||
      evidence.jobId !== id ||
      evidence.stepId !== row.stepId ||
      evidence.requestHash !== step.requestHash ||
      evidence.fingerprint !== plan.fingerprint ||
      evidence.status !== "match" ||
      evidence.actor !== row.actor ||
      row.actor !== plan.ownerId ||
      row.decision !== "adopt-existing" ||
      evidence.expiresAt <= row.decidedAt ||
      historyJson(evidence.result) === null
    )
      return invalidHistory();
    resolved.add(row.stepId);
    c.archive("publication_resolutions", String(row.stepId), row);
  }
  return resolved;
}

/** Recovery overlays preserve pending original rows; a matching historical decision is not a new dispatch. */
export function inventoryLegacyPublicationLogs(c: LegacyHistoryContext, version: number): void {
  const resolved = new Set<number>();
  if (version >= 7)
    for (const id of [...c.plans.keys()].sort()) for (const step of resolutions(c, id)) resolved.add(step);
  const children = [
    ["publication_effects", 2],
    ["publication_steps", 3],
    ["publication_confirmations", 4],
    ["publication_observations", 5],
    ["publication_cancellations", 6],
    ["publication_recovery_evidence", 7],
  ] as const;
  for (const [table, minimum] of children) {
    if (version < minimum) continue;
    c.children(table, "jobId", c.plans.keys(), (row) => {
      const id = String(row.jobId),
        plan = c.plans.get(id)!;
      if (table === "publication_effects" && row.acknowledgedAt === null)
        c.block("unknown-effect", id, "unacknowledged-effect:" + row.id);
      if (table === "publication_steps") {
        if (!["pending", "succeeded", "rejected"].includes(String(row.outcome))) return invalidHistory();
        if (row.outcome === "pending" && !resolved.has(row.id as number))
          c.block("unknown-effect", id, "pending-step:" + row.id);
        if (row.result !== null) historyJson(row.result);
      }
      if (table === "publication_confirmations") {
        if (row.fingerprint !== plan.fingerprint) return invalidHistory();
        historyJson(row.details);
      }
      if (table === "publication_observations") historyJson(row.result);
      if (table === "publication_recovery_evidence") {
        const step = c.db
          .query<{ jobId: string; requestHash: string }, [number]>(
            "SELECT jobId,requestHash FROM publication_steps WHERE id=?",
          )
          .get(row.stepId as number);
        if (
          !step ||
          step.jobId !== id ||
          step.requestHash !== row.requestHash ||
          row.fingerprint !== plan.fingerprint ||
          !["match", "mismatch", "unavailable"].includes(String(row.status))
        )
          return invalidHistory();
        if (historyJson(row.result) === null && row.status === "match") return invalidHistory();
        historyJson(row.details);
      }
      return JSON.stringify([row.jobId, row.id ?? row.observationKey ?? "singleton"]);
    });
  }
  if (version >= 8) {
    const seen = new Set<string>();
    for (const id of [...c.plans.keys()].sort()) {
      for (const row of c.db
        .query<{ parentId: string; childId: string }, [string, string]>(
          "SELECT * FROM publication_successors WHERE parentId=? OR childId=? ORDER BY childId",
        )
        .iterate(id, id)) {
        if (!c.plans.has(row.parentId) || !c.plans.has(row.childId)) return invalidHistory();
        if (!seen.has(row.childId)) {
          readWorkflowLineage(c.db, row.childId);
          c.archive("publication_successors", row.childId, row);
          seen.add(row.childId);
        }
      }
    }
  }
}
