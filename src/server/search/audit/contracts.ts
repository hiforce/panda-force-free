import { createHash } from "node:crypto";
import type { SearchJobRow } from "../state.js";
import type { SearchAuditOutcome as AuditOutcome, SearchAuditView } from "../../../shared/search/contracts.js";
export type {
  SearchAuditStatus as AuditStatus,
  SearchAuditOutcome as AuditOutcome,
  SearchAuditReport as AuditReport,
} from "../../../shared/search/contracts.js";
export interface AuditTicket {
  key: string;
  generation: string;
  token: string;
  row: SearchJobRow;
  sourceRevision: number;
}
export interface SearchAuditStore {
  claim(row: SearchJobRow, sourceRevision: number): AuditTicket | null;
  finish(ticket: AuditTicket, outcome: AuditOutcome, repair: () => boolean): boolean;
  request(row: SearchJobRow, sourceRevision: number): boolean;
  view(row: SearchJobRow | null, sourceRevision: number): SearchAuditView;
}
/** A repair request does not create a new physical generation or reset its failure backoff. */
export function auditGeneration(row: SearchJobRow, sourceRevision: number): string {
  let active: unknown = row.active;
  try {
    if (row.active) {
      const { invalidated: _invalidated, ...identity } = JSON.parse(row.active);
      active = identity;
    }
  } catch {}
  return createHash("sha256")
    .update(JSON.stringify([active, row.commitId, row.revision, sourceRevision]))
    .digest("hex");
}
