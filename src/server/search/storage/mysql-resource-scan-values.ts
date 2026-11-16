import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import type { SearchResourceInventoryView, SearchResourceSummary } from "../../../shared/search/resource-inventory.js";
import type { IndexResourceCursor } from "../resources/inventory.js";
import { SearchError } from "../../../shared/search/contracts.js";
import type { IndexResourceObservation } from "../resources/inventory.js";
export interface ResourceScanRow {
  storage: string;
  epoch: number;
  state: Exclude<SearchResourceInventoryView["state"], "idle">;
  token: string | null;
  leaseUntil: number;
  nextAt: number;
  cursor: string;
  batches: number;
  startedAt: number | null;
  checkedAt: number | null;
  completedAt: number | null;
  attempts: number;
  failure: SearchResourceInventoryView["failure"];
  previous: string | null;
  summary: string;
}
export function resourceScanCursor(value: string): IndexResourceCursor {
  try {
    if (typeof value !== "string" || value.length > 256) throw Error();
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      Object.keys(parsed).sort().join() !== "allocations,physical" ||
      [parsed.physical, parsed.allocations].some(
        (v) => v !== null && v !== "" && (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)),
      )
    )
      throw Error();
    return parsed;
  } catch {
    throw new SearchError("configuration", 409);
  }
}
export const emptyResourceSummary = (): SearchResourceSummary => ({
  checked: 0,
  protected: 0,
  retained: 0,
  missing: 0,
  removed: 0,
  failed: 0,
});
export function readResourceSummary(value: string): SearchResourceSummary {
  try {
    if (typeof value !== "string" || value.length > 512) throw Error();
    const result = JSON.parse(value),
      keys = Object.keys(emptyResourceSummary());
    if (
      !result ||
      Object.keys(result).length !== keys.length ||
      keys.some((k) => !Number.isSafeInteger(result[k]) || result[k] < 0 || result[k] > 100000) ||
      result.checked + result.failed > 100000 ||
      result.protected + result.retained > result.checked ||
      result.missing > result.checked + result.failed
    )
      throw Error();
    return result;
  } catch {
    throw new SearchError("configuration", 409);
  }
}
export function resourceScanPrevious(value: string | null): SearchResourceInventoryView["previous"] {
  if (value === null) return null;
  try {
    if (typeof value !== "string" || value.length > 1024) throw Error();
    const previous = JSON.parse(value);
    if (
      !previous ||
      Object.keys(previous).sort().join() !== "completedAt,summary" ||
      !Number.isSafeInteger(previous.completedAt) ||
      previous.completedAt < 0 ||
      previous.completedAt > 8640000000000000
    )
      throw Error();
    return { completedAt: previous.completedAt, summary: readResourceSummary(JSON.stringify(previous.summary)) };
  } catch {
    throw new SearchError("configuration", 409);
  }
}
export function updateResourceSummary(
  summary: SearchResourceSummary,
  observation: IndexResourceObservation,
  delta: 1 | -1,
) {
  summary[observation.status === "unavailable" ? "failed" : "checked"] += delta;
  if (observation.status === "protected") summary.protected += delta;
  if (["unowned", "unverified"].includes(observation.status)) summary.retained += delta;
  if (observation.status === "removed") summary.removed += delta;
  if (observation.missing && observation.status !== "removed") summary.missing += delta;
}
/** Unique observations prevent double-counting resources reached through both physical and allocation inventories. */
export async function mysqlResourceScanSummary(
  db: MySQLMetadataContext,
  row: ResourceScanRow,
): Promise<SearchResourceSummary> {
  const summary = readResourceSummary(row.summary);
  if (row.startedAt !== null) {
    const removed = (await db.one<{
      n: number;
    }>(
      "SELECT count(*) n FROM panda_force_search_resources WHERE storage=? AND state='deleted' AND updatedAt>=? AND updatedAt<=?",
      [row.storage, row.startedAt, row.completedAt ?? Number.MAX_SAFE_INTEGER],
    ))!.n;
    summary.removed = Math.max(summary.removed, removed);
  }
  return summary;
}
