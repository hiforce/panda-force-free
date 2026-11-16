/** Inventory metadata contains no original bodies, credentials or replacement publication authorization. */
export interface LegacyHistoryRecord {
  table: string;
  key: string;
  digest: string;
  bytes: number;
}
export interface LegacyHistoryBlocker {
  kind:
    "active-edit" | "unsettled-edit" | "active-build" | "unconfirmed-plan" | "active-publication" | "unknown-effect";
  id: string;
  state: string;
}
export interface LegacyHistoryInventory {
  schema: 1;
  projectId: string;
  sourceHash: string;
  schemas: Record<string, number>;
  records: LegacyHistoryRecord[];
  blockers: LegacyHistoryBlocker[];
  digest: string;
}
