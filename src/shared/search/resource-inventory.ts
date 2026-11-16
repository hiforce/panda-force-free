export interface SearchResourceSummary {
  checked: number;
  protected: number;
  retained: number;
  missing: number;
  removed: number;
  failed: number;
}
export interface SearchResourceInventoryView {
  state: "idle" | "queued" | "running" | "ready" | "failed";
  automatic: boolean;
  batches: number;
  startedAt: number | null;
  checkedAt: number | null;
  completedAt: number | null;
  nextAt: number | null;
  failure: "unavailable" | "forbidden" | "configuration" | "limit" | null;
  summary: SearchResourceSummary;
  previous: { completedAt: number; summary: SearchResourceSummary } | null;
}
