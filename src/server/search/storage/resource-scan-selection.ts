import type { Database } from "bun:sqlite";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchId } from "../../../shared/search/validation.js";

const key = (storage: string) => "resource-scan-connection:" + storage;

/** Pin only a configured profile identifier. Credentials remain in their independently encrypted connection store. */
export function selectResourceScanConnection(db: Database, storage: string, epoch: number, connection: string) {
  db.query("INSERT OR REPLACE INTO search_meta VALUES(?,?)").run(
    key(storage),
    JSON.stringify({ epoch, connection: searchId(connection) }),
  );
}

export function resourceScanConnection(db: Database, storage: string, epoch: number) {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM search_meta WHERE id=?").get(key(storage));
  if (!row) return null;
  try {
    if (typeof row.value !== "string" || row.value.length > 512) throw Error();
    const value = JSON.parse(row.value);
    if (
      !value ||
      Object.keys(value).sort().join() !== "connection,epoch" ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1
    )
      throw Error();
    return value.epoch === epoch ? searchId(value.connection) : null;
  } catch {
    throw new SearchError("configuration", 409);
  }
}
