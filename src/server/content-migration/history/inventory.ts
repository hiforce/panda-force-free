import { LegacyHistoryContext, historyHash } from "./context.js";
import { inventoryLegacyVariants } from "./variants.js";
import { inventoryLegacyEditorial } from "./editorial.js";
import { inventoryLegacyBuilds } from "./builds.js";
import { inventoryLegacyPublications } from "./publications.js";
import type { LegacyHistoryInventory } from "./contracts.js";
import type { LegacyProjectDocuments } from "../../project-content/migration/legacy-documents.js";
import { stableJson } from "../../../shared/stable-json.js";

/** Read-only cutover preflight. A successful inventory is neither reconciliation nor storage activation. */
export function inventoryLegacyProjectHistory(source: LegacyProjectDocuments): LegacyHistoryInventory {
  return source.inspect((db) => {
    const context = new LegacyHistoryContext(db, source.projectId, source.records());
    inventoryLegacyVariants(context);
    inventoryLegacyEditorial(context);
    inventoryLegacyBuilds(context);
    inventoryLegacyPublications(context);
    const snapshot = {
      schema: 1 as const,
      projectId: source.projectId,
      sourceHash: source.sourceHash,
      schemas: context.schemas,
      records: context.records.toSorted((a, b) => a.table.localeCompare(b.table) || a.key.localeCompare(b.key)),
      blockers: context.blockers.toSorted(
        (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.state.localeCompare(b.state),
      ),
    };
    return { ...snapshot, digest: historyHash(stableJson(snapshot)) };
  });
}
