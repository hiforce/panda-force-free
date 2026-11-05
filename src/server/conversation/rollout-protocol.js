import { isRecord } from "../../shared/records.js";

/** Validate records before the reducer mutates its journal-derived state.
 * @param {unknown} value
 * @returns {value is import("./rollout-types.js").RolloutEvent}
 */
function isRolloutEvent(value) {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (typeof payload.type !== "string") return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== "string") return false;
  for (const field of [
    "turn_id",
    "id",
    "call_id",
    "client_id",
    "role",
    "phase",
    "name",
    "message",
    "status",
    "stderr",
    "stdout",
  ])
    if (payload[field] !== undefined && typeof payload[field] !== "string") return false;
  for (const field of ["started_at", "completed_at"])
    if (payload[field] !== undefined && (typeof payload[field] !== "number" || !Number.isFinite(payload[field])))
      return false;
  for (const field of ["local_images", "images"])
    if (
      payload[field] !== undefined &&
      (!Array.isArray(payload[field]) || !payload[field].every((value) => typeof value === "string"))
    )
      return false;
  if (payload.type === "task_started" && !payload.turn_id) return false;
  if (
    payload.changes !== undefined &&
    (!isRecord(payload.changes) ||
      !Object.values(payload.changes).every(
        (change) =>
          isRecord(change) &&
          ["type", "unified_diff", "content"].every(
            (key) => change[key] === undefined || typeof change[key] === "string",
          ) &&
          (change.move_path == null || typeof change.move_path === "string"),
      ))
  )
    return false;
  if (payload.success !== undefined && typeof payload.success !== "boolean") return false;
  return true;
}

/** @param {unknown} value */
export function readRolloutEvent(value) {
  return isRolloutEvent(value) ? value : null;
}
