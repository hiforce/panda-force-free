import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import {
  emptyResourceSummary,
  resourceScanPrevious,
  readResourceSummary,
  type ResourceScanRow,
} from "./resource-scan-values.js";
import { validResourceScan } from "./resource-scan-validation.js";
import { resourceScanConnection, selectResourceScanConnection } from "./resource-scan-selection.js";

export const initialResourceCursor = JSON.stringify({ physical: "", allocations: "" });
const select = (db: Database, storage: string) =>
  db.query<ResourceScanRow, [string]>("SELECT * FROM search_resource_scans WHERE storage=?").get(storage);

/** Restart a damaged derived cycle without deleting receipts, allocations, reference guards or project settings. */
export function resetResourceScan(db: Database, row: ResourceScanRow, now: number) {
  let epoch =
    Number.isSafeInteger(row.epoch) && row.epoch > 0 && row.epoch < Number.MAX_SAFE_INTEGER ? row.epoch + 1 : 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!epoch) epoch = randomBytes(6).readUIntBE(0, 6) + 1;
    if (
      epoch !== row.epoch &&
      !db
        .query(
          "SELECT 1 FROM search_resource_observations WHERE storage=? AND epoch=? UNION ALL SELECT 1 FROM search_resource_requests WHERE storage=? AND epoch=? LIMIT 1",
        )
        .get(row.storage, epoch, row.storage, epoch)
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
  db.query(
    "UPDATE search_resource_scans SET epoch=?,state='queued',token=NULL,leaseUntil=0,nextAt=?,cursor=?,batches=0,startedAt=NULL,checkedAt=NULL,completedAt=NULL,attempts=0,failure=NULL,previous=?,summary=? WHERE storage=?",
  ).run(epoch, now, initialResourceCursor, previous, JSON.stringify(emptyResourceSummary()), row.storage);
  db.query("INSERT OR REPLACE INTO search_meta VALUES(?,?)").run(
    "resource-scan-recovery:" + row.storage,
    JSON.stringify({ at: now, reason: "invalid-derived-checkpoint" }),
  );
  try {
    const connection = resourceScanConnection(db, row.storage, row.epoch);
    if (connection) selectResourceScanConnection(db, row.storage, epoch, connection);
  } catch {
    /* An invalid explicit selection remains visible as a configuration failure until an administrator retries. */
  }
  return select(db, row.storage)!;
}

export function readResourceScan(db: Database, storage: string, now: () => number) {
  const row = select(db, storage);
  if (!row || validResourceScan(row)) return row;
  return db
    .transaction(() => {
      const current = select(db, storage);
      return !current || validResourceScan(current) ? current : resetResourceScan(db, current, now());
    })
    .immediate();
}
