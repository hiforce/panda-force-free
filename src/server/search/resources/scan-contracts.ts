import type { SearchResourceInventoryView } from "../../../shared/search/resource-inventory.js";
import type { IndexResourceLifecycle } from "./lifecycle.js";
import type { IndexResourceCursor, IndexResourceObservation } from "./inventory.js";

export interface ResourceScanTicket {
  storage: string;
  epoch: number;
  token: string;
  cursor: IndexResourceCursor;
}
export interface ResourceScanTarget {
  connection: string;
  owner: IndexResourceLifecycle;
  automatic: boolean;
  preferred?: boolean;
}
export interface ResourceScanStore {
  request(storage: string, operation: string, connection?: string): void;
  connection?(storage: string): string | null;
  claim(storage: string, automatic: boolean): ResourceScanTicket | null;
  heartbeat(ticket: ResourceScanTicket): boolean;
  finish(ticket: ResourceScanTicket, next: IndexResourceCursor, observations: IndexResourceObservation[]): boolean;
  fail(ticket: ResourceScanTicket, code: NonNullable<SearchResourceInventoryView["failure"]>): void;
  view(storage: string, automatic: boolean): SearchResourceInventoryView;
}
