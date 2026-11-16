import type { Database } from "bun:sqlite";
import type { SearchScope, SearchSettings } from "../../../shared/search/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchSettings } from "../../../shared/search/validation.js";
import { searchScopeKey } from "../scope.js";
import type { SearchJobRow } from "../state.js";

import { validSearchProjectPolicy, type ProjectPolicy } from "./project-policy.js";
/** Project rules are primary metadata; execution slots and indexes can be reconstructed without widening those rules. */
export class SearchProjectPolicies {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  get(scope: Pick<SearchScope, "source" | "project">) {
    return this.db
      .query<ProjectPolicy, [string, string]>("SELECT * FROM search_project_policies WHERE source=? AND project=?")
      .get(scope.source, scope.project);
  }
  valid(row: SearchJobRow) {
    return validSearchProjectPolicy(row, row.project === "personal" ? null : this.get(row));
  }
  validFor(rows: readonly SearchJobRow[]) {
    const keys = [...new Set(rows.filter((row) => row.project !== "personal").map((row) => row.key))];
    const policies = new Map<string, ProjectPolicy>();
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128);
      for (const policy of this.db
        .query<ProjectPolicy, string[]>(
          `SELECT * FROM search_project_policies WHERE key IN (${batch.map(() => "?").join(",")})`,
        )
        .all(...batch))
        policies.set(policy.key, policy);
    }
    return new Set(rows.filter((row) => validSearchProjectPolicy(row, policies.get(row.key))).map((row) => row.key));
  }
  configure(scope: SearchScope, settings: SearchSettings, revision: number) {
    const previous = this.get(scope);
    if ((previous?.revision ?? 0) !== revision) throw new SearchError("conflict", 409);
    this.db
      .query(
        `INSERT INTO search_project_policies VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(source,project)
      DO UPDATE SET owner=excluded.owner,settings=excluded.settings,revision=excluded.revision,needsReview=0,updatedAt=excluded.updatedAt`,
      )
      .run(
        scope.source,
        scope.project,
        searchScopeKey(scope),
        scope.owner,
        JSON.stringify(settings),
        revision + 1,
        this.now(),
      );
  }
  /** One bounded metadata pass restores missing/mismatched slots. It never reads content or invokes a provider/model. */
  restore(scope?: Pick<SearchScope, "source" | "project">) {
    this.db
      .transaction(() => {
        const policies = this.db
          .query<ProjectPolicy, string[]>(
            `SELECT p.* FROM search_project_policies p LEFT JOIN search_scopes s ON s.key=p.key
        WHERE (s.key IS NULL OR s.source!=p.source OR s.project!=p.project OR s.owner!=p.owner OR s.settings!=p.settings OR s.revision!=p.revision
          OR (p.needsReview=1 AND s.state!='needsReview'))` +
              (scope ? " AND p.source=? AND p.project=? LIMIT 1" : " LIMIT 8"),
          )
          .all(...(scope ? [scope.source, scope.project] : []));
        for (const p of policies) {
          let settings: SearchSettings;
          try {
            settings = searchSettings(JSON.parse(p.settings));
          } catch {
            continue;
          }
          const old = this.db.query<SearchJobRow, [string]>("SELECT * FROM search_scopes WHERE key=?").get(p.key);
          if (old?.active)
            this.db
              .query("INSERT INTO search_retired(descriptor,due) VALUES(?,?)")
              .run(old.active, this.now() + 300000);
          this.db
            .query(
              `INSERT INTO search_scopes(key,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,?,?,?,?,?,1,?,?)
          ON CONFLICT(key) DO UPDATE SET source=excluded.source,project=excluded.project,owner=excluded.owner,settings=excluded.settings,revision=excluded.revision,requested=requested+1,
          state=excluded.state,active=NULL,commitId=NULL,documentCount=0,token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=excluded.updatedAt`,
            )
            .run(
              p.key,
              p.source,
              p.owner,
              p.project,
              p.settings,
              p.revision,
              p.needsReview ? "needsReview" : settings.enabled ? "queued" : "disabled",
              this.now(),
            );
        }
      })
      .immediate();
  }
  summary(scope: SearchScope) {
    if (scope.project === "personal") return null;
    const policy = this.get(scope),
      count = this.db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) n FROM search_scope_history WHERE source=? AND project=?",
        )
        .get(scope.source, scope.project)!.n;
    return { shared: true, needsReview: policy?.needsReview === 1, previous: count };
  }
  page(scope: SearchScope, offset: number) {
    if (scope.project === "personal" || !Number.isSafeInteger(offset) || offset < 0 || offset > 256)
      throw new SearchError("invalidInput");
    const rows = this.db
        .query<{ legacyKey: string; snapshot: string }, [string, string, number]>(
          "SELECT legacyKey,snapshot FROM search_scope_history WHERE source=? AND project=? ORDER BY json_extract(snapshot,'$.updatedAt') DESC,legacyKey LIMIT 5 OFFSET ?",
        )
        .all(scope.source, scope.project, offset),
      items = rows.slice(0, 4).map((row) => {
        const old = JSON.parse(row.snapshot) as SearchJobRow;
        let settings: SearchSettings | null = null;
        try {
          settings = searchSettings(JSON.parse(old.settings));
        } catch {}
        return { id: row.legacyKey, owner: old.owner, revision: old.revision, updatedAt: old.updatedAt, settings };
      });
    return { items, nextOffset: rows.length > 4 ? offset + 4 : null };
  }
}
