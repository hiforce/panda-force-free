import type { HarnessMetadataTransaction, HarnessRecord } from "./ports.js";
import { HarnessError } from "../../shared/harness/contracts.js";
export function decode<T>(row: HarnessRecord | null): T | null {
  if (!row) return null;
  try {
    return JSON.parse(row.data) as T;
  } catch {
    throw new HarnessError("historyCorrupt", 503);
  }
}
export async function save(tx: HarnessMetadataTransaction, id: string, kind: string, owner: string, value: unknown) {
  const previous = await tx.get(id);
  const record: HarnessRecord = {
    id,
    kind,
    owner,
    revision: (previous?.revision ?? 0) + 1,
    data: JSON.stringify(value),
    updatedAt: Date.now(),
  };
  await tx.put(record, previous?.revision ?? null);
  return record.revision;
}
