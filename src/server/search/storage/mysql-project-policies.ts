import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import type { SearchScope, SearchSettings } from "../../../shared/search/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchSettings } from "../../../shared/search/validation.js";
import { searchScopeKey } from "../scope.js";
import type { SearchJobRow } from "../state.js";
import { validSearchProjectPolicy, type ProjectPolicy } from "./project-policy.js";
/** Project rules are primary metadata; execution slots and indexes can be reconstructed without widening those rules. */
export class MySQLSearchProjectPolicies {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  async get(scope: Pick<SearchScope, "source" | "project">) {
    return await this.db.atomic(async () => {
      return await this.db.one<ProjectPolicy>(
        "SELECT * FROM panda_force_search_project_policies WHERE source=? AND project=?",
        [scope.source, scope.project],
      );
    });
  }
  async valid(row: SearchJobRow) {
    return validSearchProjectPolicy(row, row.project === "personal" ? null : await this.get(row));
  }
  async validFor(rows: readonly SearchJobRow[]) {
    return this.db.atomic(async () => {
      const keys = [...new Set(rows.filter((row) => row.project !== "personal").map((row) => row.key))];
      const policies = new Map<string, ProjectPolicy>();
      for (let offset = 0; offset < keys.length; offset += 128) {
        const batch = keys.slice(offset, offset + 128);
        for (const policy of await this.db.all<ProjectPolicy>(
          `SELECT * FROM panda_force_search_project_policies WHERE \`key\` IN (${batch.map(() => "?").join(",")})`,
          batch,
        ))
          policies.set(policy.key, policy);
      }
      return new Set(rows.filter((row) => validSearchProjectPolicy(row, policies.get(row.key))).map((row) => row.key));
    });
  }
  async configure(scope: SearchScope, settings: SearchSettings, revision: number) {
    return await this.db.atomic(async () => {
      const previous = await this.get(scope);
      if ((previous?.revision ?? 0) !== revision) throw new SearchError("conflict", 409);
      await this.db.execute(
        `INSERT INTO panda_force_search_project_policies VALUES(?,?,?,?,?,?,0,?) ON DUPLICATE KEY UPDATE owner=VALUES(owner),settings=VALUES(settings),revision=VALUES(revision),needsReview=0,updatedAt=VALUES(updatedAt)`,
        [
          scope.source,
          scope.project,
          searchScopeKey(scope),
          scope.owner,
          JSON.stringify(settings),
          revision + 1,
          this.now(),
        ],
      );
    });
  }
  /** One bounded metadata pass restores missing/mismatched slots. It never reads content or invokes a provider/model. */
  async restore(scope?: Pick<SearchScope, "source" | "project">) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const policies = await this.db.all<ProjectPolicy>(
          `SELECT p.* FROM panda_force_search_project_policies p LEFT JOIN panda_force_search_scopes s ON s.\`key\`=p.\`key\`
        WHERE (s.\`key\` IS NULL OR s.source!=p.source OR s.project!=p.project OR s.owner!=p.owner OR s.settings!=p.settings OR s.revision!=p.revision
          OR (p.needsReview=1 AND s.state!='needsReview'))` +
            (scope ? " AND p.source=? AND p.project=? LIMIT 1" : " LIMIT 8"),
          [...(scope ? [scope.source, scope.project] : [])],
        );
        for (const p of policies) {
          let settings: SearchSettings;
          try {
            settings = searchSettings(JSON.parse(p.settings));
          } catch {
            continue;
          }
          const old = await this.db.one<SearchJobRow>("SELECT * FROM panda_force_search_scopes WHERE `key`=?", [p.key]);
          if (old?.active)
            await this.db.execute("INSERT INTO panda_force_search_retired(descriptor,due) VALUES(?,?)", [
              old.active,
              this.now() + 300000,
            ]);
          await this.db.execute(
            `INSERT INTO panda_force_search_scopes(\`key\`,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,?,?,?,?,?,1,?,?)
          ON DUPLICATE KEY UPDATE source=VALUES(source),project=VALUES(project),owner=VALUES(owner),settings=VALUES(settings),revision=VALUES(revision),requested=requested+1,
          state=VALUES(state),active=NULL,commitId=NULL,documentCount=0,token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=VALUES(updatedAt)`,
            [
              p.key,
              p.source,
              p.owner,
              p.project,
              p.settings,
              p.revision,
              p.needsReview ? "needsReview" : settings.enabled ? "queued" : "disabled",
              this.now(),
            ],
          );
        }
      });
    });
  }
  async summary(scope: SearchScope) {
    return await this.db.atomic(async () => {
      if (scope.project === "personal") return null;
      const policy = await this.get(scope),
        count = (await this.db.one<{
          n: number;
        }>("SELECT COUNT(*) n FROM panda_force_search_scope_history WHERE source=? AND project=?", [
          scope.source,
          scope.project,
        ]))!.n;
      return { shared: true, needsReview: policy?.needsReview === 1, previous: count };
    });
  }
  async page(scope: SearchScope, offset: number) {
    return await this.db.atomic(async () => {
      if (scope.project === "personal" || !Number.isSafeInteger(offset) || offset < 0 || offset > 256)
        throw new SearchError("invalidInput");
      const rows = await this.db.all<{
          legacyKey: string;
          snapshot: string;
        }>(
          "SELECT legacyKey,snapshot FROM panda_force_search_scope_history WHERE source=? AND project=? ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.updatedAt')) AS SIGNED) DESC,legacyKey LIMIT 5 OFFSET ?",
          [scope.source, scope.project, offset],
        ),
        items = rows.slice(0, 4).map((row) => {
          const old = JSON.parse(row.snapshot) as SearchJobRow;
          let settings: SearchSettings | null = null;
          try {
            settings = searchSettings(JSON.parse(old.settings));
          } catch {}
          return { id: row.legacyKey, owner: old.owner, revision: old.revision, updatedAt: old.updatedAt, settings };
        });
      return { items, nextOffset: rows.length > 4 ? offset + 4 : null };
    });
  }
}
