import type { Database } from "bun:sqlite";

export const uncertainReferenceKey = "unverified-index-references";
export const referenceFloorKey = "index-reference-orphan-floor";

/** Presence protects even a damaged legacy marker. An unreadable grace floor cannot authorize cleanup. */
export function readReferenceBarrier(db: Database) {
  const rows = db
      .query<{ id: string; value: unknown }, []>(
        "SELECT id,value FROM search_meta WHERE id IN ('unverified-index-references','index-reference-orphan-floor')",
      )
      .all(),
    saved = rows.find((row) => row.id === referenceFloorKey),
    raw = saved?.value;
  let floor = -1;
  if (saved) {
    floor = typeof raw === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(raw) ? Number(raw) : Infinity;
    if (!Number.isSafeInteger(floor) || floor < 0 || floor > 8640000000000000) floor = Infinity;
  }
  return { floor, uncertain: rows.some((row) => row.id === uncertainReferenceKey) || !Number.isFinite(floor) };
}
