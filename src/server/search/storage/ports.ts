import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import type { SearchAuditStore, AuditTicket, AuditOutcome } from "../audit/contracts.js";
/** The callback commits within the selected ledger transaction. SQLite supplies a direct result; MySQL awaits its own facet. */
export type SearchAuditPersistence = Omit<MetadataStore<SearchAuditStore>, "finish"> & {
  finish(
    ticket: AuditTicket,
    outcome: AuditOutcome,
    repair: () => boolean | Promise<boolean>,
  ): boolean | Promise<boolean>;
};
