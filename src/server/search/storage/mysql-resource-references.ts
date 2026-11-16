import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { decodeSearchIndex } from "../descriptor.js";
import { validResourceAllocation } from "../resources/validation.js";
import type { IndexResourceAllocation } from "../resources/contracts.js";
import type { IndexReference } from "../ports.js";
import { mysqlReadReferenceBarrier } from "./mysql-reference-barrier.js";
interface ReferenceRow {
  key: string;
  active: string;
  source: string;
}
const decodedReferences = new WeakMap<
  MySQLMetadataContext,
  Map<
    string,
    {
      active: string;
      source: string;
      name: string | null;
      valid: boolean;
    }
  >
>();
/** Invalid descriptors protect every allocation until a full reconciliation establishes current references. */
export async function mysqlResourceReferenced(db: MySQLMetadataContext, name: string) {
  if ((await mysqlReadReferenceBarrier(db)).uncertain) return true;
  const rows = await db.all<ReferenceRow>(
    "SELECT `key`,active,source FROM panda_force_search_scopes WHERE active IS NOT NULL LIMIT 257",
    [],
  );
  if (rows.length > 256) return true;
  let cache = decodedReferences.get(db);
  if (!cache) {
    cache = new Map();
    decodedReferences.set(db, cache);
  }
  return rows.some((row) => {
    let entry = cache.get(row.key);
    if (!entry || entry.active !== row.active || entry.source !== row.source) {
      const active = decodeSearchIndex(row.active, row.source);
      entry = { active: row.active, source: row.source, name: active?.vector?.name ?? null, valid: !!active };
      cache.set(row.key, entry);
      while (cache.size > 256) cache.delete(cache.keys().next().value!);
    }
    return !entry.valid || entry.name === name;
  });
}
/** Activation and retirement claims use the same SQLite writer transaction, including component reuse. */
export async function mysqlResourceActivationAllowed(db: MySQLMetadataContext, reference: IndexReference) {
  const identity = (r: IndexReference) =>
    JSON.stringify([
      r.name,
      r.provider,
      r.integrity?.schema,
      r.integrity?.format,
      r.integrity?.digest,
      r.integrity?.count,
      r.integrity?.recipe,
      r.integrity?.pageSize,
      r.integrity?.checkpoint,
    ]);
  return (
    await db.all<IndexResourceAllocation>("SELECT * FROM panda_force_search_resources WHERE name=?", [reference.name])
  ).every(
    (row) =>
      validResourceAllocation(row) &&
      row.state === "ready" &&
      row.reference !== null &&
      identity(JSON.parse(row.reference)) === identity(reference),
  );
}
