import type { Database } from "bun:sqlite";
import type { SearchJobRow } from "../state.js";
import { searchScopeKey } from "../scope.js";
import { DEFAULT_SEARCH_SETTINGS, searchSettings } from "../../../shared/search/validation.js";
import { stableJson } from "../../../shared/stable-json.js";

/** Preserve exact legacy policy, execution and audit metadata before replacing only derived project slots. */
export function migrateProjectSearchScopes(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_project_policies(
    source TEXT NOT NULL REFERENCES search_sources(id),project TEXT NOT NULL,key TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,settings TEXT NOT NULL,revision INTEGER NOT NULL,needsReview INTEGER NOT NULL CHECK(needsReview IN (0,1)),
    updatedAt INTEGER NOT NULL,PRIMARY KEY(source,project));
    CREATE TABLE IF NOT EXISTS search_scope_history(
      legacyKey TEXT PRIMARY KEY,source TEXT NOT NULL,project TEXT NOT NULL,snapshot TEXT NOT NULL,
      auditQueue TEXT NOT NULL,auditReports TEXT NOT NULL,migratedAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS search_scope_history_page ON search_scope_history(source,project,legacyKey);`);
  const rows = db
    .query<SearchJobRow, []>(
      "SELECT * FROM search_scopes WHERE project!='personal' ORDER BY source,project,updatedAt DESC,key",
    )
    .all();
  if (rows.length > 256) throw new Error("Project search migration exceeds the supported scope limit");
  const groups = new Map<string, SearchJobRow[]>();
  for (const row of rows) {
    const key = searchScopeKey(row);
    if (db.query("SELECT 1 FROM search_project_policies WHERE key=?").get(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const now = Date.now();
  for (const [key, group] of groups) {
    const first = group[0]!,
      signatures = new Set<string>();
    let invalid = false,
      revision = 0;
    for (const row of group) {
      if (
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        row.revision >= Number.MAX_SAFE_INTEGER ||
        Buffer.byteLength(row.settings) > 1024 * 1024
      )
        throw new Error("Invalid legacy project search metadata");
      revision = Math.max(revision, row.revision);
      try {
        signatures.add(stableJson(searchSettings(JSON.parse(row.settings))));
      } catch {
        invalid = true;
      }
      db.query("INSERT INTO search_scope_history VALUES(?,?,?,?,?,?,?)").run(
        row.key,
        row.source,
        row.project,
        JSON.stringify(row),
        JSON.stringify(db.query("SELECT * FROM search_audit_queue WHERE key=?").get(row.key) ?? null),
        JSON.stringify(db.query("SELECT * FROM search_audit_reports WHERE key=? ORDER BY id").all(row.key)),
        now,
      );
      // Physical resources enter the existing conservative retirement path after a grace period; originals are untouched.
      if (row.active) db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,?)").run(row.active, now + 300000);
      db.query("DELETE FROM search_scopes WHERE key=?").run(row.key);
    }
    const conflict = invalid || signatures.size !== 1,
      settings = conflict
        ? JSON.stringify(DEFAULT_SEARCH_SETTINGS)
        : JSON.stringify(searchSettings(JSON.parse(first.settings))),
      state = conflict ? "needsReview" : JSON.parse(settings).enabled ? "queued" : "disabled";
    db.query("INSERT INTO search_project_policies VALUES(?,?,?,?,?,?,?,?)").run(
      first.source,
      first.project,
      key,
      first.owner,
      settings,
      revision + 1,
      conflict ? 1 : 0,
      now,
    );
    db.query(
      "INSERT INTO search_scopes(key,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,?,?,?,?,?,1,?,?)",
    ).run(key, first.source, first.owner, first.project, settings, revision + 1, state, now);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS search_shared_project ON search_scopes(source,project) WHERE project!='personal';
    CREATE TRIGGER IF NOT EXISTS search_project_insert_guard BEFORE INSERT ON search_scopes WHEN NEW.project!='personal' BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM search_project_policies p WHERE p.source=NEW.source AND p.project=NEW.project
        AND p.key=NEW.key AND p.owner=NEW.owner AND p.settings=NEW.settings AND p.revision=NEW.revision
        AND (p.needsReview=0 OR NEW.state='needsReview'))
        THEN RAISE(ABORT,'search_project_policy') END;
    END;
    CREATE TRIGGER IF NOT EXISTS search_project_update_guard BEFORE UPDATE OF key,source,owner,project,settings,revision,state ON search_scopes
      WHEN NEW.project!='personal' OR OLD.project!='personal' BEGIN
      SELECT CASE WHEN NEW.project='personal' OR NOT EXISTS(SELECT 1 FROM search_project_policies p WHERE p.source=NEW.source AND p.project=NEW.project
        AND p.key=NEW.key AND p.owner=NEW.owner AND p.settings=NEW.settings AND p.revision=NEW.revision
        AND (p.needsReview=0 OR NEW.state='needsReview'))
        THEN RAISE(ABORT,'search_project_policy') END;
    END;
    PRAGMA user_version=3;`);
}
