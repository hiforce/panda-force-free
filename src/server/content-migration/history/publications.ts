import type { SitePublicationPlan, SitePublicationRequest } from "../../../shared/delivery/contracts.js";
import type { WorkflowPlan } from "../../../shared/delivery/workflow.js";
import { readWorkflowPlan } from "../../delivery/storage/workflow-plan-read.js";
import { verifiedArtifact } from "../../delivery/validation.js";
import { socialPayload } from "../../delivery/social/payload.js";
import { LegacyHistoryContext, historyHash, historyJson, invalidHistory } from "./context.js";
import { inventoryLegacyPublicationLogs } from "./logs.js";

type PlanRow = {
  id: string;
  ownerId: string;
  spaceId: string;
  record: string;
  request: string;
  artifactHash: string | null;
  kind?: string;
  sourceProjectId?: string | null;
};
const tables = [
  ["publication_snapshots", 1],
  ["publication_plans", 1],
  ["publication_jobs", 1],
  ["publication_effects", 2],
  ["publication_steps", 3],
  ["publication_confirmations", 4],
  ["publication_observations", 5],
  ["publication_cancellations", 6],
  ["publication_recovery_evidence", 7],
  ["publication_resolutions", 7],
  ["publication_successors", 8],
] as const;

function sitePlan(c: LegacyHistoryContext, row: PlanRow, snapshots: Set<string>): void {
  const plan = historyJson<SitePublicationPlan>(row.record),
    request = historyJson<SitePublicationRequest>(row.request);
  if (
    plan?.id !== row.id ||
    plan.projectId !== c.projectId ||
    plan.spaceId !== row.spaceId ||
    plan.sourceProjectId !== undefined ||
    plan.build?.sourceSnapshot !== undefined ||
    request?.id !== row.id ||
    request.projectId !== undefined ||
    request.buildId !== plan.buildId ||
    !c.builds.has(plan.buildId)
  )
    return invalidHistory();
  if (row.artifactHash === null) return;
  const snapshot = c.db
    .query<{ hash: string; payload: string; bytes: number }, [string]>(
      "SELECT * FROM publication_snapshots WHERE hash=?",
    )
    .get(row.artifactHash);
  if (
    !snapshot ||
    historyHash(snapshot.payload) !== snapshot.hash ||
    Buffer.byteLength(snapshot.payload) !== snapshot.bytes
  )
    return invalidHistory();
  const artifact = verifiedArtifact(historyJson(snapshot.payload));
  if (
    historyHash(
      JSON.stringify({
        request,
        build: plan.build,
        connection: plan.connection,
        files: artifact.files.map(({ path, sha256 }) => ({ path, sha256 })),
      }),
    ) !== plan.fingerprint
  )
    return invalidHistory();
  if (!snapshots.has(snapshot.hash)) {
    c.archive("publication_snapshots", snapshot.hash, snapshot);
    snapshots.add(snapshot.hash);
  }
}

function workflowPlan(c: LegacyHistoryContext, row: PlanRow): void {
  const plan: WorkflowPlan = readWorkflowPlan(row.record, row.request, row.id, row.kind!);
  if (plan.projectId !== c.projectId || plan.spaceId !== row.spaceId || plan.sourceProjectId !== undefined)
    return invalidHistory();
  if (!["x-post", "x-article-draft", "x-article-publish"].includes(plan.kind)) return;
  const payload = socialPayload(plan),
    variant = c.variants.get(payload.source.variantId);
  c.source(payload.source);
  if (
    !variant ||
    variant.documentId !== payload.source.documentId ||
    variant.revisionId !== payload.source.revisionId ||
    variant.digest !== payload.source.variantDigest
  )
    return invalidHistory();
  for (const image of payload.media ?? []) {
    const asset = c.db
      .query<{ documentId: string; digest: string; size: number; mime: string }, [string]>(
        "SELECT documentId,digest,size,mime FROM document_assets WHERE id=?",
      )
      .get(image.assetId);
    if (
      !asset ||
      asset.documentId !== payload.source.documentId ||
      asset.digest !== image.digest ||
      asset.size !== image.size ||
      asset.mime !== image.mime
    )
      return invalidHistory();
  }
}

/** Pending approvals and unknown effects are reported, never converted into new permission or successful outcomes. */
export function inventoryLegacyPublications(c: LegacyHistoryContext): void {
  const version = c.domain("publication_delivery_schema", 9, tables);
  if (!version) return;
  if (version >= 9) c.legacyScope("publication_plans", "sourceProjectId");
  const snapshots = new Set<string>();
  for (const row of c.db
    .query<PlanRow, [string]>(`SELECT * FROM publication_plans WHERE spaceId IN (${c.spaceFilter}) ORDER BY id`)
    .iterate(c.projectId)) {
    if (row.sourceProjectId != null) return invalidHistory();
    try {
      if ((row.kind ?? "site") === "site") sitePlan(c, row, snapshots);
      else workflowPlan(c, row);
    } catch {
      return invalidHistory();
    }
    const job = c.db
      .query<{ id: string; phase: string }, [string]>("SELECT * FROM publication_jobs WHERE id=?")
      .get(row.id);
    if (!job) return invalidHistory();
    const terminal =
      (row.kind ?? "site") === "site" ? ["published", "failed", "cancelled"] : ["completed", "failed", "cancelled"];
    if (job.phase === "prepared") c.block("unconfirmed-plan", row.id, job.phase);
    else if (job.phase === "needsAttention") c.block("unknown-effect", row.id, job.phase);
    else if (!terminal.includes(job.phase)) {
      if (!["queued", "running", "reconciling", "waiting"].includes(job.phase)) return invalidHistory();
      c.block("active-publication", row.id, job.phase);
    }
    c.archive("publication_plans", row.id, row);
    c.archive("publication_jobs", row.id, job);
    const plan = historyJson<{ fingerprint: string }>(row.record);
    if (typeof plan.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(plan.fingerprint)) return invalidHistory();
    c.plans.set(row.id, { ownerId: row.ownerId, fingerprint: plan.fingerprint, kind: row.kind ?? "site" });
  }
  inventoryLegacyPublicationLogs(c, version);
}
