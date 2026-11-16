import type { Database } from "bun:sqlite";

import { searchSettings } from "../../../shared/search/validation.js";
import type { SearchJobRow } from "../state.js";

import { SearchProjectPolicies } from "./project-policies.js";
import { SearchIndexMetadata } from "./index-metadata.js";
import { decodeSearchIndex } from "../descriptor.js";

/** Batched catalog reads and source readiness are independent of job mutation and execution leases. */
export class SearchJobCatalog {
  constructor(
    private readonly db: Database,
    private readonly policies: SearchProjectPolicies,
    private readonly metadata: SearchIndexMetadata,
  ) {}
  all() {
    this.policies.restore();
    const rows = this.db.query<SearchJobRow, []>("SELECT * FROM search_scopes ORDER BY updatedAt").all(),
      valid = this.policies.validFor(rows);
    if (rows.some((row) => !valid.has(row.key) && row.active !== null)) this.metadata.retainUnknownReferences();
    return rows.map((row) => {
      if (valid.has(row.key)) return this.metadata.recover(row);
      return { ...row, state: "failed", failure: "configuration" };
    });
  }
  hasReadyIndex(source: string, revision: number) {
    return this.db
      .transaction(() => {
        let after = "";
        for (;;) {
          const rows = this.db
            .query<SearchJobRow, [string, string]>(
              "SELECT * FROM search_scopes WHERE source=? AND state='ready' AND key>? ORDER BY key LIMIT 64",
            )
            .all(source, after);
          if (!rows.length) return false;
          const valid = this.policies.validFor(rows);
          if (rows.some((row) => !valid.has(row.key) && row.active !== null)) this.metadata.retainUnknownReferences();
          for (const candidate of rows) {
            if (!valid.has(candidate.key)) continue;
            const row = this.metadata.recover(candidate),
              active = row.active === null ? null : decodeSearchIndex(row.active, row.source);
            if (
              row.state === "ready" &&
              searchSettings(JSON.parse(row.settings)).enabled &&
              active?.sourceRevision === revision &&
              !active.invalidated &&
              active.settingsRevision === row.revision
            )
              return true;
          }
          after = rows.at(-1)!.key;
        }
      })
      .immediate();
  }
}
