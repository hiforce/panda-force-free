import type { Database } from "bun:sqlite";
import { decodeSearchIndex } from "../descriptor.js";
import type { SearchJobRow } from "../state.js";
import { SearchProjectPolicies } from "./project-policies.js";
import { readReferenceBarrier, referenceFloorKey, uncertainReferenceKey } from "./reference-barrier.js";

/** The complete bounded proof and guard release share one writer transaction; no asynchronous snapshot can clear a later event. */
export function reconcileIndexReferences(db: Database, now = Date.now) {
  return db
    .transaction(() => {
      const barrier = readReferenceBarrier(db);
      if (!barrier.uncertain) return false;
      const rows = db.query<SearchJobRow, []>("SELECT * FROM search_scopes ORDER BY key LIMIT 257").all(),
        policies = new SearchProjectPolicies(db, now);
      if (
        rows.length > 256 ||
        rows.some((row) => !policies.valid(row) || (row.active !== null && !decodeSearchIndex(row.active, row.source)))
      )
        return false;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) return false;
      const floor = Math.max(Number.isFinite(barrier.floor) ? barrier.floor : -1, time);
      db.query("INSERT OR REPLACE INTO search_meta VALUES(?,?)").run(referenceFloorKey, String(floor));
      db.query("DELETE FROM search_meta WHERE id=?").run(uncertainReferenceKey);
      return true;
    })
    .immediate();
}
