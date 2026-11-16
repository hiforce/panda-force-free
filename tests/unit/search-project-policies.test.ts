import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLegacySearchDatabase } from "../support/search-ledger-v2.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs, scopeKey } from "../../src/server/search/storage/jobs.js";
import { SearchProjectPolicies } from "../../src/server/search/storage/project-policies.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { SearchJobRow } from "../../src/server/search/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() {
  const root = mkdtempSync(join(tmpdir(), "panda-project-search-upgrade-"));
  roots.push(root);
  return join(root, "search.sqlite");
}
const settings = { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["secret.md"] };
function insert(db: Database, owner: string, project = "project", overrides: Partial<SearchJobRow> = {}) {
  const row: SearchJobRow = {
    key: createHash("sha256")
      .update(JSON.stringify(["builtin", owner, project]))
      .digest("hex"),
    source: "builtin",
    owner,
    project,
    settings: JSON.stringify(settings),
    revision: 3,
    requested: 2,
    state: "running",
    attempts: 1,
    token: "legacy-worker",
    leaseUntil: 5000,
    active: JSON.stringify({
      text: { provider: "local", name: "a".repeat(64) },
      vector: null,
      source: {
        id: "builtin",
        name: "Built-in search",
        kind: "local",
        connection: null,
        knowledge: null,
        enabled: true,
        revision: 1,
      },
      sourceRevision: 1,
      settingsRevision: 3,
      analyzer: settings.analyzer,
      embedding: null,
      textFingerprint: "legacy",
    }),
    commitId: "source-version",
    documentCount: 2,
    failure: null,
    updatedAt: 1000,
    ...overrides,
  };
  db.query(
    `INSERT INTO search_scopes(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
  return row;
}
test("schema-two project scopes converge without changing personal scopes or losing exact audit and worker metadata", () => {
  const file = path();
  let db = openLegacySearchDatabase(file);
  const old = insert(db, "alice"),
    latest = insert(db, "bob", "project", { revision: 7, updatedAt: 2000 });
  const personal = insert(db, "alice", "personal");
  db.query("INSERT INTO search_audit_queue VALUES(?,?,?,5000,6000,2)").run(old.key, "generation", "audit-worker");
  db.query("INSERT INTO search_audit_reports VALUES(1,?,?,2000,?)").run(old.key, "generation", '{"status":"healthy"}');
  const queue = db.query("SELECT * FROM search_audit_queue").get(),
    reports = db.query("SELECT * FROM search_audit_reports").all();
  db.close();
  db = openSearchDatabase(file);
  try {
    const jobs = new SearchJobs(db),
      alice = { source: "builtin", project: "project", owner: "alice" };
    const shared = jobs.get(alice)!;
    expect(jobs.get({ ...alice, owner: "bob" })).toEqual(shared);
    expect(shared.key).toBe(scopeKey(alice));
    expect(shared.owner).toBe("bob");
    expect(shared.revision).toBe(8);
    expect(shared.state).toBe("queued");
    expect(jobs.settings(shared)).toEqual(settings);
    expect(new SearchProjectPolicies(db).page(alice, 0).items[0]?.owner).toBe("bob");
    expect(shared.active).toBeNull();
    expect(jobs.get({ ...alice, project: "personal" })).toEqual(personal);
    const archived = db
      .query<{ snapshot: string; auditQueue: string; auditReports: string }, [string]>(
        "SELECT * FROM search_scope_history WHERE legacyKey=?",
      )
      .get(old.key)!;
    expect(JSON.parse(archived.snapshot)).toEqual(old);
    expect(JSON.parse(archived.auditQueue)).toEqual(queue);
    expect(JSON.parse(archived.auditReports)).toEqual(reports);
    expect(
      db
        .query<{ snapshot: string }, [string]>("SELECT snapshot FROM search_scope_history WHERE legacyKey=?")
        .get(latest.key)?.snapshot,
    ).toBe(JSON.stringify(latest));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM search_retired").get()?.n).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM search_scopes").get()?.n).toBe(2);
  } finally {
    db.close();
  }
  db = openSearchDatabase(file);
  expect(new SearchJobs(db).all()).toHaveLength(2);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM search_scope_history").get()?.n).toBe(2);
  db.close();
});

test("conflicting legacy exclusions require an explicit shared policy choice and cannot be enabled by an old writer", () => {
  const file = path();
  let db = openLegacySearchDatabase(file);
  const old = insert(db, "alice");
  insert(db, "bob", "project", { settings: JSON.stringify({ ...settings, exclude: [] }) });
  db.close();
  db = openSearchDatabase(file);
  try {
    const jobs = new SearchJobs(db),
      scope = { source: "builtin", project: "project", owner: "bob" };
    const shared = jobs.get(scope)!;
    expect(shared.state).toBe("needsReview");
    expect(jobs.settings(shared).enabled).toBeFalse();
    jobs.wake(shared.key, true);
    expect(jobs.claim()).toBeNull();
    expect(() => db.query("UPDATE search_scopes SET state='queued' WHERE key=?").run(shared.key)).toThrow(
      "search_project_policy",
    );
    expect(() => insert(db, "charlie")).toThrow("search_project_policy");
    const policy = new SearchProjectPolicies(db);
    expect(policy.summary(scope)).toEqual({ shared: true, needsReview: true, previous: 2 });
    expect(policy.page(scope, 0).items.find((i) => i.id === old.key)?.settings?.exclude).toEqual(["secret.md"]);
    expect(() => jobs.configure(scope, settings, shared.revision - 1)).toThrow("conflict");
    jobs.configure(scope, settings, shared.revision);
    expect(policy.summary(scope)?.needsReview).toBeFalse();
    expect(jobs.settings(jobs.get({ ...scope, owner: "alice" })!).exclude).toEqual(["secret.md"]);
    expect(jobs.claim()?.owner).toBe("bob");
  } finally {
    db.close();
  }
});

test("a requested project restores its exact primary policy even when more than one repair batch is missing", () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db);
  try {
    for (let i = 0; i < 12; i++)
      jobs.configure({ source: "builtin", project: "project-" + i, owner: "admin" }, settings, 0);
    db.exec("DELETE FROM search_scopes");
    const scope = { source: "builtin", project: "project-11", owner: "member" };
    const row = jobs.get(scope)!;
    expect(row).not.toBeNull();
    expect(row.owner).toBe("admin");
    expect(jobs.settings(row).exclude).toEqual(["secret.md"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM search_scopes").get()?.n).toBe(1);
    expect(() => jobs.configure(scope, { ...settings, exclude: [] }, 0)).toThrow("conflict");
    db.exec(
      "CREATE TEMP TRIGGER fail_slot BEFORE INSERT ON search_scopes BEGIN SELECT RAISE(ABORT,'slot failed');END;",
    );
    expect(() => jobs.configure(scope, { ...settings, exclude: [] }, row.revision)).toThrow("slot failed");
    expect(jobs.settings(jobs.get(scope)!).exclude).toEqual(["secret.md"]);
    expect(new SearchProjectPolicies(db).get(scope)?.owner).toBe("admin");
  } finally {
    db.close();
  }
});

test("a rejected legacy upgrade rolls back policy archives and schema changes without erasing originals", () => {
  const file = path();
  let db = openLegacySearchDatabase(file);
  const first = insert(db, "alice", "a"),
    bad = insert(db, "bob", "b", { revision: Number.MAX_SAFE_INTEGER });
  db.close();
  expect(() => openSearchDatabase(file)).toThrow("Invalid legacy project search metadata");
  db = new Database(file, { strict: true });
  try {
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(db.query("SELECT * FROM search_scopes ORDER BY project").all()).toEqual([first, bad]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='search_project_policies'").get()).toBeNull();
    expect(db.query("SELECT name FROM sqlite_master WHERE name='search_scope_history'").get()).toBeNull();
  } finally {
    db.close();
  }
});

test("an unreadable legacy rule is archived exactly and cannot silently enable an index", () => {
  const file = path();
  let db = openLegacySearchDatabase(file);
  const old = insert(db, "alice", "project", { settings: "{invalid-json" });
  db.close();
  db = openSearchDatabase(file);
  try {
    const scope = { source: "builtin", project: "project", owner: "alice" },
      jobs = new SearchJobs(db);
    expect(jobs.get(scope)?.state).toBe("needsReview");
    expect(jobs.settings(jobs.get(scope)!).enabled).toBeFalse();
    expect(new SearchProjectPolicies(db).page(scope, 0).items[0]?.settings).toBeNull();
    expect(
      JSON.parse(
        db
          .query<{ snapshot: string }, [string]>("SELECT snapshot FROM search_scope_history WHERE legacyKey=?")
          .get(old.key)!.snapshot,
      ),
    ).toEqual(old);
    expect(jobs.claim()).toBeNull();
  } finally {
    db.close();
  }
});
