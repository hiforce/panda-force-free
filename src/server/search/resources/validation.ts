import type { IndexResourceAllocation } from "./contracts.js";

const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Unknown or damaged allocation metadata cannot grant deletion or activation authority. */
export function validResourceAllocation(row: IndexResourceAllocation) {
  if (
    !digest(row.storage) ||
    !digest(row.name) ||
    typeof row.recipe !== "string" ||
    !row.recipe ||
    row.recipe.length > 1000 ||
    typeof row.marker !== "string" ||
    !row.marker ||
    row.marker.length > 512 ||
    !["building", "ready", "retiring", "deleted", "unverified"].includes(row.state) ||
    (row.token !== null && (typeof row.token !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(row.token))) ||
    ![row.leaseUntil, row.createdAt, row.updatedAt].every(timestamp) ||
    (row.orphanSince !== null && !timestamp(row.orphanSince))
  )
    return false;
  if (
    row.identity !== null &&
    (typeof row.identity !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(row.identity) ||
      BigInt(row.identity) > 9223372036854775807n)
  )
    return false;
  if (row.state === "ready" && (row.identity === null || row.reference === null)) return false;
  if (row.reference !== null) {
    try {
      if (typeof row.reference !== "string" || row.reference.length > 65536) return false;
      const ref = JSON.parse(row.reference),
        i = ref?.integrity;
      if (
        ref?.name !== row.name ||
        ref.provider !== "milvus" ||
        i?.schema !== 1 ||
        i.format !== "milvus-seal/1" ||
        i.recipe !== row.recipe ||
        !digest(i.digest) ||
        !Number.isSafeInteger(i.count) ||
        i.count < 0
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
