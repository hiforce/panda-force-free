import { MySQLSearchJobCatalog } from "./mysql-catalog.js";
import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { SearchError, type SearchScope, type SearchSettings } from "../../../shared/search/contracts.js";
import { DEFAULT_SEARCH_SETTINGS, searchSettings } from "../../../shared/search/validation.js";
import type { ActiveSearchIndex, SearchJobRow, RetiredSearchIndex } from "../state.js";

import { searchScopeKey as scopeKey } from "../scope.js";
import { MySQLSearchProjectPolicies } from "./mysql-project-policies.js";
import { MySQLSearchIndexMetadata } from "./mysql-index-metadata.js";
import { decodeSearchIndex } from "../descriptor.js";
import { MySQLSearchProgressStore, type BuildUpdate } from "./mysql-progress.js";

import { mysqlReconcileIndexReferences } from "./mysql-reference-reconciliation.js";
export class MySQLSearchJobRecords {
  protected policies: MySQLSearchProjectPolicies;
  protected metadata: MySQLSearchIndexMetadata;
  protected progressStore: MySQLSearchProgressStore;
  private readonly catalog: MySQLSearchJobCatalog;
  constructor(
    protected db: MySQLMetadataContext,
    protected now = () => Date.now(),
  ) {
    this.policies = new MySQLSearchProjectPolicies(db, now);
    this.metadata = new MySQLSearchIndexMetadata(db, now);
    this.progressStore = new MySQLSearchProgressStore(db, now);
    this.catalog = new MySQLSearchJobCatalog(db, this.policies, this.metadata);
  }
  async get(scope: SearchScope) {
    return await this.db.atomic(async () => {
      if (scope.project !== "personal") await this.policies.restore(scope);
      const row = await this.byKey(scopeKey(scope));
      if (row && !(await this.policies.valid(row))) throw new SearchError("configuration", 409);
      return row;
    });
  }
  async byKey(key: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<SearchJobRow>("SELECT * FROM panda_force_search_scopes WHERE `key`=?", [key]);
      return row ? await this.metadata.recover(row) : null;
    });
  }
  async view(row: SearchJobRow | null) {
    return await this.db.atomic(async () => {
      const active = row && this.active(row);
      return row
        ? {
            settings: searchSettings(JSON.parse(row.settings)),
            revision: row.revision,
            state: row.state,
            documentCount: row.documentCount,
            failure: row.failure,
            updatedAt: row.updatedAt,
            progress: await this.progressStore.view(row),
            ready: !!active && !active.invalidated && active.settingsRevision === row.revision,
          }
        : {
            settings: { ...DEFAULT_SEARCH_SETTINGS },
            revision: 0,
            state: "disabled",
            documentCount: 0,
            failure: null,
            updatedAt: 0,
            progress: null,
            ready: false,
          };
    });
  }
  all = () => this.catalog.all();
  /** Walk every candidate page; readiness checks never repair or scan unrelated sources. */
  hasReadyIndex = (source: string, revision: number) => this.catalog.hasReadyIndex(source, revision);
  async retired(after = 0) {
    return await this.db.atomic(async () => {
      return await this.db.all<RetiredSearchIndex>(
        "SELECT id,descriptor FROM panda_force_search_retired WHERE id>? AND due<=? ORDER BY id LIMIT 32",
        [after, this.now()],
      );
    });
  }
  async forget(id: number) {
    return await this.db.atomic(async () => {
      await this.db.execute("DELETE FROM panda_force_search_retired WHERE id=?", [id]);
    });
  }
  async progress(row: SearchJobRow, value: BuildUpdate) {
    return await this.db.atomic(async () => {
      return await this.progressStore.update(row, value);
    });
  }
  active(row: SearchJobRow): ActiveSearchIndex | null {
    return row.active === null ? null : decodeSearchIndex(row.active, row.source);
  }
  async referencesUncertain() {
    return await this.db.atomic(async () => {
      return await this.metadata.referencesUncertain();
    });
  }
  async reconcileReferences() {
    return await this.db.atomic(async () => {
      if (!(await this.metadata.referencesUncertain())) return false;
      await this.all();
      return await mysqlReconcileIndexReferences(this.db, this.now);
    });
  }
  settings(row: SearchJobRow): SearchSettings {
    return searchSettings(JSON.parse(row.settings));
  }
}
