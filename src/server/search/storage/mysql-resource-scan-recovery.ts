import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomBytes } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import {
  emptyResourceSummary,
  resourceScanPrevious,
  readResourceSummary,
  type ResourceScanRow,
} from "./mysql-resource-scan-values.js";
import { validResourceScan } from "./mysql-resource-scan-validation.js";
import { mysqlResourceScanConnection, mysqlSelectResourceScanConnection } from "./mysql-resource-scan-selection.js";
export const initialResourceCursor = JSON.stringify({ physical: "", allocations: "" });
const select = async (db: MySQLMetadataContext, storage: string) =>
  await db.one<ResourceScanRow>("SELECT * FROM panda_force_search_resource_scans WHERE storage=?", [storage]);
/** Restart a damaged derived cycle without deleting receipts, allocations, reference guards or project settings. */
export async function mysqlResetResourceScan(db: MySQLMetadataContext, row: ResourceScanRow, now: number) {
  let epoch =
    Number.isSafeInteger(row.epoch) && row.epoch > 0 && row.epoch < Number.MAX_SAFE_INTEGER ? row.epoch + 1 : 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!epoch) epoch = randomBytes(6).readUIntBE(0, 6) + 1;
    if (
      epoch !== row.epoch &&
      !(await db.one(
        "SELECT 1 FROM panda_force_search_resource_observations WHERE storage=? AND epoch=? UNION ALL SELECT 1 FROM panda_force_search_resource_requests WHERE storage=? AND epoch=? LIMIT 1",
        [row.storage, epoch, row.storage, epoch],
      ))
    )
      break;
    epoch = 0;
  }
  if (!epoch) throw new SearchError("configuration", 409);
  let previous: string | null = null;
  try {
    if (resourceScanPrevious(row.previous)) previous = row.previous;
    if (Number.isSafeInteger(row.completedAt) && row.completedAt! >= 0 && row.completedAt! <= 8640000000000000)
      previous = JSON.stringify({ completedAt: row.completedAt, summary: readResourceSummary(row.summary) });
  } catch {
    /* Unreadable history is derived metadata, never a cleanup authorization. */
  }
  await db.execute(
    "UPDATE panda_force_search_resource_scans SET epoch=?,state='queued',token=NULL,leaseUntil=0,nextAt=?,`cursor`=?,batches=0,startedAt=NULL,checkedAt=NULL,completedAt=NULL,attempts=0,failure=NULL,previous=?,summary=? WHERE storage=?",
    [epoch, now, initialResourceCursor, previous, JSON.stringify(emptyResourceSummary()), row.storage],
  );
  await db.execute(
    "INSERT INTO panda_force_search_meta(id,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    ["resource-scan-recovery:" + row.storage, JSON.stringify({ at: now, reason: "invalid-derived-checkpoint" })],
  );
  try {
    const connection = await mysqlResourceScanConnection(db, row.storage, row.epoch);
    if (connection) await mysqlSelectResourceScanConnection(db, row.storage, epoch, connection);
  } catch {
    /* An invalid explicit selection remains visible as a configuration failure until an administrator retries. */
  }
  return select(db, row.storage)!;
}
export async function mysqlReadResourceScan(db: MySQLMetadataContext, storage: string, now: () => number) {
  const row = await select(db, storage);
  if (!row || validResourceScan(row)) return row;
  return await db.atomic(async () => {
    const current = await select(db, storage);
    return !current || validResourceScan(current) ? current : await mysqlResetResourceScan(db, current, now());
  });
}
