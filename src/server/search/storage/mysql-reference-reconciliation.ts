import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { decodeSearchIndex } from "../descriptor.js";
import type { SearchJobRow } from "../state.js";
import { MySQLSearchProjectPolicies } from "./mysql-project-policies.js";
import { mysqlReadReferenceBarrier, referenceFloorKey, uncertainReferenceKey } from "./mysql-reference-barrier.js";
/** The complete bounded proof and guard release share one writer transaction; no asynchronous snapshot can clear a later event. */
export async function mysqlReconcileIndexReferences(db: MySQLMetadataContext, now = Date.now) {
  return await db.atomic(async () => {
    const barrier = await mysqlReadReferenceBarrier(db);
    if (!barrier.uncertain) return false;
    const rows = await db.all<SearchJobRow>("SELECT * FROM panda_force_search_scopes ORDER BY `key` LIMIT 257", []),
      policies = new MySQLSearchProjectPolicies(db, now);
    if (rows.length > 256) return false;
    for (const row of rows) {
      if (!(await policies.valid(row)) || (row.active !== null && !decodeSearchIndex(row.active, row.source)))
        return false;
    }
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) return false;
    const floor = Math.max(Number.isFinite(barrier.floor) ? barrier.floor : -1, time);
    await db.execute(
      "INSERT INTO panda_force_search_meta(id,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      [referenceFloorKey, String(floor)],
    );
    await db.execute("DELETE FROM panda_force_search_meta WHERE id=?", [uncertainReferenceKey]);
    return true;
  });
}
