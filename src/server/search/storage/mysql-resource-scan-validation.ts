import {
  resourceScanCursor,
  resourceScanPrevious,
  readResourceSummary,
  type ResourceScanRow,
} from "./mysql-resource-scan-values.js";
const timestamp = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8640000000000000;
const optionalTime = (value: unknown) => value === null || timestamp(value);
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const token = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Only derived scan checkpoints are recoverable here; ownership and primary project policies are independent. */
export function validResourceScan(row: ResourceScanRow) {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(row.storage) ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 1 ||
      row.epoch >= Number.MAX_SAFE_INTEGER ||
      !["queued", "running", "ready", "failed"].includes(row.state) ||
      !timestamp(row.leaseUntil) ||
      !timestamp(row.nextAt) ||
      !count(row.batches) ||
      !optionalTime(row.startedAt) ||
      !optionalTime(row.checkedAt) ||
      !optionalTime(row.completedAt) ||
      !count(row.attempts) ||
      row.attempts > 16 ||
      (row.state === "running"
        ? typeof row.token !== "string" || !token.test(row.token) || row.leaseUntil === 0
        : row.token !== null || row.leaseUntil !== 0) ||
      (row.state === "failed"
        ? !["unavailable", "forbidden", "configuration", "limit"].includes(row.failure ?? "") || row.attempts === 0
        : row.failure !== null)
    )
      return false;
    const cursor = resourceScanCursor(row.cursor);
    const summary = readResourceSummary(row.summary);
    if (summary.protected + summary.retained + summary.removed > summary.checked) return false;
    resourceScanPrevious(row.previous);
    if (row.state === "ready" && row.completedAt === null) return false;
    if (
      row.completedAt !== null &&
      (row.startedAt === null ||
        row.checkedAt === null ||
        cursor.physical !== null ||
        cursor.allocations !== null ||
        !["ready", "failed"].includes(row.state))
    )
      return false;
    if (row.state === "running" && row.startedAt === null) return false;
    return true;
  } catch {
    return false;
  }
}
export function validStoredObservation(row: { status: string; missing: number }) {
  return (
    ["retained", "protected", "unowned", "unverified", "removed", "unavailable"].includes(row.status) &&
    (row.missing === 0 || row.missing === 1) &&
    (row.status !== "removed" || row.missing === 0)
  );
}
