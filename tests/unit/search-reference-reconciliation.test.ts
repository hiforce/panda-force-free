import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { SearchIndexResources, resourceGraceMs } from "../../src/server/search/storage/resources.js";
import { reconcileIndexReferences } from "../../src/server/search/storage/reference-reconciliation.js";
import {
  readReferenceBarrier,
  referenceFloorKey,
  uncertainReferenceKey,
} from "../../src/server/search/storage/reference-barrier.js";
import { resourceReferenced } from "../../src/server/search/storage/resource-references.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { ActiveSearchIndex } from "../../src/server/search/state.js";

const storage = "a".repeat(64),
  name = "b".repeat(64),
  physical = { name, identity: "448707763883002001", marker: "owned-marker" };
function fixture() {
  const db = openSearchDatabase(":memory:");
  let now = 1000000;
  const jobs = new SearchJobs(db, () => now),
    resources = new SearchIndexResources(db, () => now),
    scope = { source: "builtin", project: "personal", owner: "owner" };
  const active: ActiveSearchIndex = {
    text: { provider: "local", name: "c".repeat(64) },
    vector: null,
    source: new SearchSourceRegistry(db).get("builtin"),
    sourceRevision: 1,
    settingsRevision: 1,
    analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
    embedding: null,
    textFingerprint: "fixture",
  };
  const allocate = () => {
    const row = resources.reserve(storage, name, "recipe", physical.marker);
    resources.release({ storage, name, token: row.token! });
  };
  return {
    db,
    jobs,
    resources,
    scope,
    active,
    allocate,
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("automatic reconciliation archives a broken slot, fences its worker and rearms orphan grace without changing primary settings", () => {
  const f = fixture();
  try {
    f.allocate();
    f.resources.observe(storage, name, physical);
    f.tick(resourceGraceMs + 1);
    f.jobs.configure(f.scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const old = f.jobs.claim()!,
      settings = f.db.query("SELECT settings,revision,requested FROM search_scopes").get();
    f.db.query("UPDATE search_scopes SET active=?").run("{broken");
    f.jobs.all();
    expect(f.jobs.referencesUncertain()).toBeTrue();
    expect(f.jobs.reconcileReferences()).toBeTrue();
    expect(f.jobs.referencesUncertain()).toBeFalse();
    expect(f.db.query("SELECT descriptor FROM search_retired").get()).toEqual({ descriptor: "{broken" });
    expect(f.db.query("SELECT settings,revision FROM search_scopes").get()).toEqual({
      settings: (settings as { settings: string }).settings,
      revision: 1,
    });
    expect(f.jobs.complete(old, f.active, "late", 0)).toBeFalse();
    expect(f.resources.claimDrop(storage, name, physical, true)).toBeNull();
    f.resources.observe(storage, name, physical);
    expect(f.resources.get(storage, name)?.orphanSince).toBe(f.now());
    f.tick(resourceGraceMs + 1);
    f.resources.observe(storage, name, physical);
    expect(f.resources.claimDrop(storage, name, physical, true)).not.toBeNull();
  } finally {
    f.db.close();
  }
});

test("a later guard release fences an already claimed retirement; post-release allocations can still compensate immediately", () => {
  const f = fixture();
  try {
    f.allocate();
    const claimed = f.resources.claimDrop(storage, name, physical, true)!;
    expect(claimed).not.toBeNull();
    f.tick(1);
    f.db.query("INSERT INTO search_meta VALUES(?,'1')").run(uncertainReferenceKey);
    expect(reconcileIndexReferences(f.db, f.now)).toBeTrue();
    expect(f.resources.mayDrop(claimed, physical)).toBeFalse();
    f.tick(1);
    const fresh = "d".repeat(64),
      p = { ...physical, name: fresh };
    const reserved = f.resources.reserve(storage, fresh, "recipe", p.marker);
    f.resources.release({ storage, name: fresh, token: reserved.token! });
    expect(f.resources.claimDrop(storage, fresh, p, true)).not.toBeNull();
  } finally {
    f.db.close();
  }
});

test("damaged derived guard values require a complete current-reference proof and cannot override broken primary rules", () => {
  const f = fixture();
  try {
    const scope = { ...f.scope, project: "project" };
    f.jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    f.db.query("INSERT INTO search_meta VALUES(?,?)").run(uncertainReferenceKey, "invalid");
    f.db.query("INSERT INTO search_meta VALUES(?,?)").run(referenceFloorKey, "invalid");
    expect(resourceReferenced(f.db, name)).toBeTrue();
    f.db.query("UPDATE search_project_policies SET settings=?").run("{broken-primary");
    expect(reconcileIndexReferences(f.db, f.now)).toBeFalse();
    expect(readReferenceBarrier(f.db).uncertain).toBeTrue();
    expect(f.db.query("SELECT settings FROM search_project_policies").get()).toEqual({ settings: "{broken-primary" });
    f.db
      .query("UPDATE search_project_policies SET settings=?")
      .run(JSON.stringify({ ...DEFAULT_SEARCH_SETTINGS, enabled: true }));
    expect(reconcileIndexReferences(f.db, f.now)).toBeTrue();
    expect(readReferenceBarrier(f.db)).toEqual({ floor: f.now(), uncertain: false });
  } finally {
    f.db.close();
  }
});

test("cached reference decoding observes exact changed bytes and a new corrupt descriptor remains protective", () => {
  const f = fixture();
  try {
    f.jobs.configure(f.scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const vector = { ...f.active, text: null, vector: { provider: "milvus" as const, name }, embedding: "recipe" };
    f.db.query("UPDATE search_scopes SET active=?").run(JSON.stringify(vector));
    expect(resourceReferenced(f.db, name)).toBeTrue();
    expect(resourceReferenced(f.db, "e".repeat(64))).toBeFalse();
    f.db.query("UPDATE search_scopes SET active=?").run("{new-corruption");
    expect(resourceReferenced(f.db, "e".repeat(64))).toBeTrue();
    f.db.query("INSERT INTO search_meta VALUES(?,'1')").run(uncertainReferenceKey);
    expect(reconcileIndexReferences(f.db, f.now)).toBeFalse();
  } finally {
    f.db.close();
  }
});

test("an independent database writer cannot have its new uncertainty erased by an earlier reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-reference-proof-")),
    path = join(root, "search.sqlite");
  const a = openSearchDatabase(path),
    b = new Database(path, { create: false, strict: true }),
    jobs = new SearchJobs(a);
  try {
    b.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;");
    jobs.configure(
      { source: "builtin", project: "personal", owner: "owner" },
      { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
      0,
    );
    a.query("INSERT INTO search_meta VALUES(?,'1')").run(uncertainReferenceKey);
    expect(reconcileIndexReferences(a)).toBeTrue();
    b.transaction(() => {
      b.query("UPDATE search_scopes SET active=?").run("{later-corruption");
      b.query("INSERT INTO search_meta VALUES(?,'new-event')").run(uncertainReferenceKey);
    }).immediate();
    expect(resourceReferenced(a, name)).toBeTrue();
    expect(reconcileIndexReferences(a)).toBeFalse();
    jobs.all();
    expect(jobs.reconcileReferences()).toBeTrue();
    expect(a.query("SELECT descriptor FROM search_retired").get()).toEqual({ descriptor: "{later-corruption" });
  } finally {
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  }
});
