import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { SearchError } from "../../../shared/search/contracts.js";
import { searchSettings } from "../../../shared/search/validation.js";
import { decodeSearchIndex } from "../descriptor.js";
import type { SearchJobRow } from "../state.js";
import { mysqlReadReferenceBarrier, uncertainReferenceKey } from "./mysql-reference-barrier.js";
/** Repair only the disposable slot. Preserve exact unknown references and primary rules, fencing every older worker. */
export class MySQLSearchIndexMetadata {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  async recover(row: SearchJobRow): Promise<SearchJobRow> {
    return await this.db.atomic(async () => {
      if (row.active === null ? row.state !== "ready" : decodeSearchIndex(row.active, row.source)) return row;
      return await this.db.atomic(async () => {
        // Unreadable settings are primary corruption, not permission to enable an index with default rules.
        const settings = searchSettings(JSON.parse(row.settings));
        if (
          row.project !== "personal" &&
          !(await this.db.one(
            "SELECT 1 FROM panda_force_search_project_policies WHERE `key`=? AND source=? AND project=? AND owner=? AND settings=? AND revision=?",
            [row.key, row.source, row.project, row.owner, row.settings, row.revision],
          ))
        )
          throw new SearchError("configuration", 409);
        const state = row.state === "needsReview" ? "needsReview" : settings.enabled ? "queued" : "disabled";
        const updated = (
          await this.db.execute(
            `UPDATE panda_force_search_scopes SET active=NULL,commitId=NULL,documentCount=0,requested=requested+1,state=?,
        token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=?
        WHERE \`key\`=? AND active <=> ? AND revision=? AND requested=? AND token <=> ?`,
            [state, this.now(), row.key, row.active, row.revision, row.requested, row.token],
          )
        ).changes;
        if (updated && row.active !== null) {
          await this.db.execute("INSERT INTO panda_force_search_retired(descriptor,due) VALUES(?,?)", [
            row.active,
            this.now() + 300000,
          ]);
          // Unknown physical names cannot authorize deletion, including a reused component hidden by damaged JSON.
          await this.retainUnknownReferences();
        }
        return (
          (await this.db.one<SearchJobRow>("SELECT * FROM panda_force_search_scopes WHERE `key`=?", [row.key])) ?? row
        );
      });
    });
  }
  async referencesUncertain() {
    return await this.db.atomic(async () => {
      return (await mysqlReadReferenceBarrier(this.db)).uncertain;
    });
  }
  async retainUnknownReferences() {
    return await this.db.atomic(async () => {
      if (!(await this.referencesUncertain()))
        await this.db.execute(
          "INSERT INTO panda_force_search_meta(id,value) VALUES(?,'1') ON DUPLICATE KEY UPDATE value=VALUES(value)",
          [uncertainReferenceKey],
        );
    });
  }
}
