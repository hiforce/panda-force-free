import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { searchSettings } from "../../../shared/search/validation.js";
import type { SearchJobRow } from "../state.js";

import { MySQLSearchProjectPolicies } from "./mysql-project-policies.js";
import { MySQLSearchIndexMetadata } from "./mysql-index-metadata.js";
import { decodeSearchIndex } from "../descriptor.js";

/** Batched catalog reads and source readiness are independent of job mutation and execution leases. */
export class MySQLSearchJobCatalog {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly policies: MySQLSearchProjectPolicies,
    private readonly metadata: MySQLSearchIndexMetadata,
  ) {}
  async all() {
    return await this.db.atomic(async () => {
      await this.policies.restore();
      const rows = await this.db.all<SearchJobRow>("SELECT * FROM panda_force_search_scopes ORDER BY updatedAt", []),
        valid = await this.policies.validFor(rows);
      if (rows.some((row) => !valid.has(row.key) && row.active !== null)) await this.metadata.retainUnknownReferences();
      return await Promise.all(
        rows.map(async (row) => {
          if (valid.has(row.key)) return await this.metadata.recover(row);
          return { ...row, state: "failed", failure: "configuration" };
        }),
      );
    });
  }
  async hasReadyIndex(source: string, revision: number) {
    return this.db.atomic(async () => {
      let after = "";
      for (;;) {
        const rows = await this.db.all<SearchJobRow>(
          "SELECT * FROM panda_force_search_scopes WHERE source=? AND state='ready' AND `key`>? ORDER BY `key` LIMIT 64",
          [source, after],
        );
        if (!rows.length) return false;
        const valid = await this.policies.validFor(rows);
        if (rows.some((row) => !valid.has(row.key) && row.active !== null))
          await this.metadata.retainUnknownReferences();
        for (const candidate of rows) {
          if (!valid.has(candidate.key)) continue;
          const row = await this.metadata.recover(candidate),
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
    });
  }
}
