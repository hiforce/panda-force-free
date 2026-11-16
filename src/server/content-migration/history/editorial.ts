import type {
  EditorialProposal,
  EditorialReceipt,
  EditorialApplicationIntent,
  EditorialSummaryBase,
} from "../../../shared/editorial/contracts.js";
import type { EditorialJobSpec } from "../../editorial/jobs/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { LegacyHistoryContext, historyHash, historyJson, invalidHistory } from "./context.js";

type PayloadRow = {
  id: string;
  owner: string;
  documentId: string;
  payload: string;
  digest: string;
  sourceProjectId?: string | null;
};
/** Application intent without its original receipt cannot be completed or discarded by a storage migration. */
export function inventoryLegacyEditorial(c: LegacyHistoryContext): void {
  const version = c.domain("editorial_schema", 4, [
    ["editorial_proposals", 1],
    ["editorial_applications", 1],
    ["editorial_jobs", 2],
    ["editorial_job_retries", 2],
    ["editorial_history", 3],
    ["editorial_application_intents", 4],
  ]);
  if (!version) return;
  if (version >= 4)
    for (const table of ["editorial_proposals", "editorial_history", "editorial_jobs"])
      c.legacyScope(table, "sourceProjectId");
  const proposals = new Map<string, { owner: string; digest: string; source: EditorialProposal["source"] }>();
  for (const row of c.db
    .query<PayloadRow, [string]>(
      `SELECT * FROM editorial_proposals WHERE documentId IN (${c.documentFilter}) ORDER BY id`,
    )
    .iterate(c.projectId)) {
    const proposal = historyJson<EditorialProposal>(row.payload);
    if (
      row.sourceProjectId != null ||
      historyHash(row.payload) !== row.digest ||
      proposal?.id !== row.id ||
      proposal.source?.documentId !== row.documentId
    )
      return invalidHistory();
    c.source(proposal.source);
    c.archive("editorial_proposals", row.id, row);
    proposals.set(row.id, { owner: row.owner, digest: row.digest, source: proposal.source });
  }
  const applied = new Set<string>();
  c.children("editorial_applications", "proposalId", new Set(proposals.keys()), (row) => {
    const receipt = historyJson<EditorialReceipt>(row.payload),
      proposal = proposals.get(String(row.proposalId))!;
    if (
      historyHash(String(row.payload)) !== row.digest ||
      receipt?.proposalId !== row.proposalId ||
      receipt.digest !== proposal.digest ||
      receipt.reviewer !== proposal.owner ||
      stableJson(receipt.source) !== stableJson(proposal.source) ||
      JSON.stringify(receipt.selected) !== row.selection
    )
      return invalidHistory();
    c.source(receipt.applied);
    if (receipt.applied.documentId !== receipt.source.documentId || receipt.applied.version < receipt.source.version)
      return invalidHistory();
    applied.add(receipt.proposalId);
    return receipt.proposalId;
  });
  if (version >= 4)
    c.children("editorial_application_intents", "proposalId", new Set(proposals.keys()), (row) => {
      const intent = historyJson<EditorialApplicationIntent>(row.payload),
        proposal = proposals.get(String(row.proposalId))!;
      if (
        historyHash(String(row.payload)) !== row.digest ||
        intent?.proposalId !== row.proposalId ||
        intent.digest !== proposal.digest ||
        intent.reviewer !== proposal.owner ||
        stableJson(intent.source) !== stableJson(proposal.source)
      )
        return invalidHistory();
      if (!applied.has(intent.proposalId)) c.block("unsettled-edit", intent.proposalId, "intent-without-receipt");
      return intent.proposalId;
    });
  if (version >= 3)
    c.children("editorial_history", "id", new Set(proposals.keys()), (row) => {
      const summary = historyJson<EditorialSummaryBase>(row.payload),
        proposal = proposals.get(String(row.id))!;
      if (
        historyHash(String(row.payload)) !== row.digest ||
        summary?.id !== row.id ||
        row.owner !== proposal.owner ||
        stableJson(summary.source) !== stableJson(proposal.source) ||
        row.sourceProjectId != null
      )
        return invalidHistory();
      return String(row.id);
    });
  if (version >= 3 && c.records.filter((row) => row.table === "editorial_history").length !== proposals.size)
    return invalidHistory();
  if (version < 2) return;
  const jobs = new Set<string>();
  for (const row of c.db
    .query<PayloadRow & { state: string; proposalId: string | null }, [string]>(
      `SELECT * FROM editorial_jobs WHERE documentId IN (${c.documentFilter}) ORDER BY id`,
    )
    .iterate(c.projectId)) {
    const spec = historyJson<EditorialJobSpec>(row.payload);
    if (
      row.sourceProjectId != null ||
      historyHash(row.payload) !== row.digest ||
      spec?.id !== row.id ||
      spec.source?.ref?.documentId !== row.documentId ||
      (row.proposalId !== null && !proposals.has(row.proposalId)) ||
      !["queued", "running", "succeeded", "failed", "cancelled"].includes(row.state)
    )
      return invalidHistory();
    c.source(spec.source.ref);
    if (["queued", "running"].includes(row.state)) c.block("active-edit", row.id, row.state);
    c.archive("editorial_jobs", row.id, row);
    jobs.add(row.id);
  }
  c.children("editorial_job_retries", "jobId", jobs, (row) => JSON.stringify([row.jobId, row.retryId]));
}
