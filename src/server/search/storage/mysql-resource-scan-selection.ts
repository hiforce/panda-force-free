import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { SearchError } from "../../../shared/search/contracts.js";
import { searchId } from "../../../shared/search/validation.js";
const key = (storage: string) => "resource-scan-connection:" + storage;
/** Pin only a configured profile identifier. Credentials remain in their independently encrypted connection store. */
export async function mysqlSelectResourceScanConnection(
  db: MySQLMetadataContext,
  storage: string,
  epoch: number,
  connection: string,
) {
  await db.execute(
    "INSERT INTO panda_force_search_meta(id,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [key(storage), JSON.stringify({ epoch, connection: searchId(connection) })],
  );
}
export async function mysqlResourceScanConnection(db: MySQLMetadataContext, storage: string, epoch: number) {
  const row = await db.one<{
    value: string;
  }>("SELECT value FROM panda_force_search_meta WHERE id=?", [key(storage)]);
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
