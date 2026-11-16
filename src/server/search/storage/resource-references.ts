import type { Database } from "bun:sqlite";
import { decodeSearchIndex } from "../descriptor.js";
import { validResourceAllocation } from "../resources/validation.js";
import type { IndexResourceAllocation } from "../resources/contracts.js";
import type { IndexReference } from "../ports.js";
import { readReferenceBarrier } from "./reference-barrier.js";

interface ReferenceRow {
  key: string;
  active: string;
  source: string;
}
const decodedReferences = new WeakMap<
  Database,
  Map<string, { active: string; source: string; name: string | null; valid: boolean }>
>();

/** Invalid descriptors protect every allocation until a full reconciliation establishes current references. */
export function resourceReferenced(db: Database, name: string) {
  if (readReferenceBarrier(db).uncertain) return true;
  const rows = db
    .query<ReferenceRow, []>("SELECT key,active,source FROM search_scopes WHERE active IS NOT NULL LIMIT 257")
    .all();
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
export function resourceActivationAllowed(db: Database, reference: IndexReference) {
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
  return db
    .query<IndexResourceAllocation, [string]>("SELECT * FROM search_resources WHERE name=?")
    .all(reference.name)
    .every(
      (row) =>
        validResourceAllocation(row) &&
        row.state === "ready" &&
        row.reference !== null &&
        identity(JSON.parse(row.reference)) === identity(reference),
    );
}
