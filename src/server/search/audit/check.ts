import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { SearchError } from "../../../shared/search/contracts.js";
import type { ApprovedKnowledgeSource, SearchSource } from "../ports.js";
import type { SearchLedger } from "../state.js";
import type { SearchRuntime } from "../indexer.js";
import { knowledgeEligible, knowledgeVectorDocument, knowledgeVectorInput } from "../knowledge.js";
import { IndexIntegrityError } from "../integrity.js";
import type { AuditOutcome, AuditTicket } from "./contracts.js";
import { searchReadScope } from "../content-selection.js";
export interface SearchAuditPorts {
  ledger: MetadataStore<SearchLedger>;
  content: SearchSource;
  runtime: MetadataStore<SearchRuntime>;
  knowledge?: ApprovedKnowledgeSource;
}
function failureStatus(error: unknown): AuditOutcome["status"] {
  if (error instanceof SearchError) {
    if (error.code === "forbidden" || error.code === "notFound") return "forbidden";
    if (error.code === "conflict" || error.code === "indexChanged") return "superseded";
  }
  if (error && typeof error === "object" && "status" in error && (error.status === 403 || error.status === 404))
    return "forbidden";
  return "unavailable";
}
/** Physical findings can admit repair only while saved content, permissions and provider bindings remain current. */
export async function checkSearchGeneration(
  ports: SearchAuditPorts,
  ticket: AuditTicket,
  signal: AbortSignal,
): Promise<AuditOutcome> {
  const { row } = ticket,
    checks: string[] = [];
  let count = 0,
    current: () => Promise<boolean> = async () => false;
  const result = (status: AuditOutcome["status"], action: AuditOutcome["action"] = "none"): AuditOutcome => ({
    status,
    action,
    checks,
    count,
  });
  try {
    signal.throwIfAborted();
    await ports.content.authorize(row);
    const source = await ports.runtime.source(row.source),
      settings = await ports.ledger.settings(row),
      active = await ports.ledger.active(row),
      text = settings.fulltext ? await ports.runtime.text(source) : null,
      textFingerprint = text?.fingerprint() ?? null,
      vectors = settings.vector ? await ports.runtime.vectors(source) : null,
      vectorFingerprint = vectors?.fingerprint(),
      head = await ports.content.head(searchReadScope(row, settings)),
      knowledgeHead = settings.vector && ports.knowledge ? await ports.knowledge.head(row) : undefined;
    if (!source.enabled || !settings.enabled || source.revision !== ticket.sourceRevision) return result("superseded");
    current = async () => {
      await ports.content.authorize(row);
      signal.throwIfAborted();
      return (
        (await ports.content.head(searchReadScope(row, settings))) === head &&
        (await ports.runtime.source(row.source)).revision === source.revision &&
        (!text || (await ports.runtime.text(source)).fingerprint() === textFingerprint) &&
        (!settings.vector || (await ports.runtime.vectors(source))?.fingerprint() === vectorFingerprint) &&
        (!settings.vector || !ports.knowledge || (await ports.knowledge.head(row)) === knowledgeHead)
      );
    };
    if (
      !active ||
      active.invalidated ||
      source.revision !== active.sourceRevision ||
      row.revision !== active.settingsRevision ||
      head !== row.commitId ||
      (settings.fulltext && (!active.text || textFingerprint !== active.textFingerprint)) ||
      (settings.vector &&
        (!active.vector || vectorFingerprint !== active.embedding || knowledgeHead !== active.knowledgeCommit))
    ) {
      if (text && !(await text.health())) throw new SearchError("unavailable", 503);
      if (text) checks.push("text.provider-reachable");
      if (settings.vector) {
        if (!ports.knowledge || !vectors?.storageHealth)
          return (await current()) ? result("partial") : result("superseded");
        if (!(await vectors.storageHealth(signal))) throw new SearchError("unavailable", 503);
        checks.push("vector.storage-reachable");
      }
      return (await current()) ? result("outdated", "rebuild") : result("superseded");
    }
    checks.push("source-version");
    if (text && active.text) {
      const audited = await text.audit(active.text, await ports.runtime.analyzer(active.analyzer), signal);
      count = audited.count;
      checks.push(...audited.checks.map((check) => "text." + check));
    }
    let partial = !settings.fulltext && !settings.vector;
    if (settings.vector) {
      if (!active.vector || !ports.knowledge || !vectors?.audit) partial = true;
      else {
        let approved;
        try {
          approved = await ports.knowledge.snapshot(row);
        } catch (error) {
          // Source corruption is not an index failure and cannot authorize rewriting approved knowledge.
          if (error instanceof IndexIntegrityError) throw new SearchError("unavailable", 503);
          throw error;
        }
        if (approved.commit !== knowledgeHead) return result("superseded");
        if (
          knowledgeVectorInput(
            approved.records.filter((value) => knowledgeEligible(value, settings)).map(knowledgeVectorDocument),
          ) !== active.vectorInput
        )
          return (await current()) ? result("outdated", "rebuild") : result("superseded");
        checks.push("knowledge.approved-files-and-citations");
        const audited = await vectors.audit(active.vector, signal);
        checks.push(...audited.checks.map((check) => "vector." + check));
      }
    }
    if (!(await current())) return result("superseded");
    return result(partial ? "partial" : "healthy");
  } catch (error) {
    if (signal.aborted) return result("unavailable");
    if (error instanceof IndexIntegrityError) {
      try {
        if (!(await current())) return result("superseded");
      } catch (error) {
        return result(signal.aborted ? "unavailable" : failureStatus(error));
      }
      return result(error.reason, "rebuild");
    }
    return result(failureStatus(error));
  }
}
