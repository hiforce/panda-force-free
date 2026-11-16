import type { Database } from "bun:sqlite";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchSettings } from "../../../shared/search/validation.js";
import { decodeSearchIndex } from "../descriptor.js";
import type { SearchJobRow } from "../state.js";
import { readReferenceBarrier, uncertainReferenceKey } from "./reference-barrier.js";

/** Repair only the disposable slot. Preserve exact unknown references and primary rules, fencing every older worker. */
export class SearchIndexMetadata {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  recover(row: SearchJobRow): SearchJobRow {
    if (row.active === null ? row.state !== "ready" : decodeSearchIndex(row.active, row.source)) return row;
    return this.db
      .transaction(() => {
        // Unreadable settings are primary corruption, not permission to enable an index with default rules.
        const settings = searchSettings(JSON.parse(row.settings));
        if (
          row.project !== "personal" &&
          !this.db
            .query(
              "SELECT 1 FROM search_project_policies WHERE key=? AND source=? AND project=? AND owner=? AND settings=? AND revision=?",
            )
            .get(row.key, row.source, row.project, row.owner, row.settings, row.revision)
        )
          throw new SearchError("configuration", 409);
        const state = row.state === "needsReview" ? "needsReview" : settings.enabled ? "queued" : "disabled";
        const updated = this.db
          .query(
            `UPDATE search_scopes SET active=NULL,commitId=NULL,documentCount=0,requested=requested+1,state=?,
        token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=?
        WHERE key=? AND active IS ? AND revision=? AND requested=? AND token IS ?`,
          )
          .run(state, this.now(), row.key, row.active, row.revision, row.requested, row.token).changes;
        if (updated && row.active !== null) {
          this.db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,?)").run(row.active, this.now() + 300000);
          // Unknown physical names cannot authorize deletion, including a reused component hidden by damaged JSON.
          this.retainUnknownReferences();
        }
        return this.db.query<SearchJobRow, [string]>("SELECT * FROM search_scopes WHERE key=?").get(row.key) ?? row;
      })
      .immediate();
  }
  referencesUncertain() {
    return readReferenceBarrier(this.db).uncertain;
  }
  retainUnknownReferences() {
    if (!this.referencesUncertain())
      this.db.query("INSERT OR REPLACE INTO search_meta VALUES(?,'1')").run(uncertainReferenceKey);
  }
}
