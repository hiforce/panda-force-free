import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchIndexResources, resourceGraceMs } from "../../src/server/search/storage/resources.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { IndexReference } from "../../src/server/search/ports.js";
import type { ActiveSearchIndex } from "../../src/server/search/state.js";

const storage = "a".repeat(64),
  name = "b".repeat(64),
  recipe = "approved-knowledge/model-v1";
const physical = { name, identity: "448707763883002001", marker: "panda-index/1/random-allocation" };
const reference: IndexReference = {
  name,
  provider: "milvus",
  integrity: { schema: 1, format: "milvus-seal/1", digest: "d".repeat(64), recipe, count: 0 },
};
const scope = { source: "builtin", project: "personal", owner: "owner" };
function fixture() {
  const db = openSearchDatabase(":memory:");
  let now = 1000000;
  const resources = new SearchIndexResources(db, () => now),
    jobs = new SearchJobs(db, () => now),
    source = new SearchSourceRegistry(db).get("builtin");
  const active: ActiveSearchIndex = {
    text: null,
    vector: reference,
    source,
    analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
    sourceRevision: 1,
    settingsRevision: 1,
    embedding: recipe,
    textFingerprint: null,
  };
  const reserve = () => resources.reserve(storage, name, recipe, physical.marker);
  const activate = () => {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, fulltext: false, vector: true }, 0);
    const row = jobs.claim()!;
    return { row, complete: () => jobs.complete(row, active, "approved-version", 0) };
  };
  return {
    db,
    jobs,
    resources,
    reserve,
    activate,
    active,
    tick: (delta: number) => {
      now += delta;
    },
  };
}

test("repeat inspections preserve the first orphan observation without rewriting unchanged durable metadata", () => {
  const f = fixture();
  try {
    const row = f.reserve();
    f.resources.release({ storage, name, token: row.token! });
    const first = f.resources.observe(storage, name, physical)!;
    const changes = () => f.db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    const before = changes();
    f.tick(1000);
    expect(f.resources.observe(storage, name, physical)?.orphanSince).toBe(first.orphanSince);
    expect(changes()).toBe(before);
    const pin = f.resources.pin(storage, name);
    expect(f.resources.observe(storage, name, physical)?.orphanSince).toBeNull();
    f.resources.unpin(pin);
  } finally {
    f.db.close();
  }
});

test("interrupted allocation survives restart and requires a second observation after grace before retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-index-ownership-")),
    path = join(root, "metadata.sqlite");
  let now = 1000000,
    db = openSearchDatabase(path);
  try {
    let resources = new SearchIndexResources(db, () => now);
    const ticket = resources.reserve(storage, name, recipe, physical.marker);
    db.close();
    db = openSearchDatabase(path);
    resources = new SearchIndexResources(db, () => now);
    expect(resources.get(storage, name)?.marker).toBe(physical.marker);
    expect(resources.observe(storage, name, physical)?.orphanSince).toBeNull();
    expect(resources.claimDrop(storage, name, physical)).toBeNull();
    now += 120001;
    expect(resources.heartbeat({ ...ticket, token: ticket.token! })).toBeFalse();
    expect(resources.seal({ ...ticket, token: ticket.token! }, physical, reference)).toBeFalse();
    expect(resources.observe(storage, name, physical)?.identity).toBe(physical.identity);
    expect(resources.claimDrop(storage, name, physical)).toBeNull();
    now += resourceGraceMs + 1;
    resources.observe(storage, name, physical);
    const claim = resources.claimDrop(storage, name, physical)!;
    expect(claim).not.toBeNull();
    expect(resources.mayDrop(claim, physical)).toBeTrue();
    expect(resources.mayDrop(claim, { ...physical, identity: "448707763883002002" })).toBeFalse();
    expect(resources.deleted(claim)).toBeTrue();
    expect(() => resources.reserve(storage, name, recipe, physical.marker)).toThrow("conflict");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("active components and live readers prevent cleanup; claimed retirement fences late activation", () => {
  const f = fixture();
  try {
    const reserved = f.reserve(),
      ticket = { ...reserved, token: reserved.token! };
    expect(f.resources.seal(ticket, physical, reference)).toBeTrue();
    f.resources.release(ticket);
    const work = f.activate();
    expect(work.complete()).toBeTrue();
    f.resources.observe(storage, name, physical);
    f.tick(resourceGraceMs * 2);
    expect(f.resources.claimDrop(storage, name, physical, true)).toBeNull();
    const pin = f.resources.pin(storage, name);
    f.db
      .query("UPDATE search_scopes SET active=NULL,state='queued',requested=requested+1 WHERE key=?")
      .run(work.row.key);
    const late = f.jobs.claim()!;
    expect(f.resources.claimDrop(storage, name, physical, true)).toBeNull();
    expect(f.resources.heartbeatRead(pin)).toBeTrue();
    f.resources.unpin(pin);
    const claimed = f.resources.claimDrop(storage, name, physical, true)!;
    expect(claimed).not.toBeNull();
    expect(f.jobs.complete(late, { ...f.active, settingsRevision: late.revision }, "approved-version", 0)).toBeFalse();
    expect(() => f.resources.pin(storage, name)).toThrow("notReady");
    expect(f.resources.heartbeatRead(pin)).toBeFalse();
    expect(f.resources.mayDrop(claimed, physical)).toBeTrue();
  } finally {
    f.db.close();
  }
});

test("foreign markers, recreated IDs, corrupt references and unknown ownership never authorize deletion", () => {
  const f = fixture();
  try {
    const row = f.reserve(),
      ticket = { ...row, token: row.token! };
    expect(f.resources.seal(ticket, { ...physical, marker: "foreign" }, reference)).toBeFalse();
    expect(f.resources.seal(ticket, physical, reference)).toBeTrue();
    f.resources.release(ticket);
    const work = f.activate();
    expect(work.complete()).toBeTrue();
    f.db.query("UPDATE search_scopes SET active='{broken' WHERE key=?").run(work.row.key);
    expect(f.resources.claimDrop(storage, name, physical, true)).toBeNull();
    f.db.query("UPDATE search_scopes SET active=NULL WHERE key=?").run(work.row.key);
    f.resources.observe(storage, name, { ...physical, identity: "448707763883002002" });
    expect(f.resources.get(storage, name)?.identity).toBe(physical.identity);
    expect(f.resources.get(storage, name)?.state).toBe("unverified");
    expect(f.resources.claimDrop(storage, name, physical, true)).toBeNull();
    expect(f.resources.observe(storage, "f".repeat(64), physical)).toBeNull();
    expect(f.resources.claimDrop(storage, "f".repeat(64), physical, true)).toBeNull();
  } finally {
    f.db.close();
  }
});

test("damaged allocation fields cannot authorize physical cleanup or late activation", () => {
  for (const [column, value] of [
    ["state", "future-state"],
    ["orphanSince", "not-a-time"],
    ["leaseUntil", "not-a-lease"],
    ["identity", "448707763883002001x"],
    ["reference", "{broken"],
  ]) {
    const f = fixture();
    try {
      const row = f.reserve();
      f.resources.release({ ...row, token: row.token! });
      f.resources.observe(storage, name, physical);
      f.db.query("UPDATE search_resources SET " + column + "=? WHERE storage=? AND name=?").run(value!, storage, name);
      expect(() => f.resources.claimDrop(storage, name, physical, true)).toThrow("notReady");
      expect(f.activate().complete()).toBeFalse();
    } finally {
      f.db.close();
    }
  }
});

test("owned resource activation requires the exact sealed reference rather than only the generation name", () => {
  const f = fixture();
  try {
    const reserved = f.reserve(),
      work = f.activate();
    expect(work.complete()).toBeFalse();
    expect(f.resources.seal({ ...reserved, token: reserved.token! }, physical, reference)).toBeTrue();
    const altered = {
      ...f.active,
      vector: { ...reference, integrity: { ...reference.integrity!, digest: "f".repeat(64) } },
    };
    expect(f.jobs.complete(work.row, altered, "approved-version", 0)).toBeFalse();
    expect(work.complete()).toBeTrue();
  } finally {
    f.db.close();
  }
});

test("schema-four migration adds empty allocation metadata and preserves exact existing rows across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-index-resource-upgrade-")),
    path = join(root, "metadata.sqlite");
  let db = openSearchDatabase(path);
  try {
    new SearchJobs(db).configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const before = db.query("SELECT * FROM search_scopes").all(),
      meta = db.query("SELECT * FROM search_meta").all();
    db.exec("DROP TABLE search_resource_reads;DROP TABLE search_resources;PRAGMA user_version=4;");
    db.close();
    db = openSearchDatabase(path);
    expect(db.query("SELECT * FROM search_scopes").all()).toEqual(before);
    expect(db.query("SELECT * FROM search_meta").all()).toEqual(meta);
    expect(db.query("SELECT * FROM search_resources").all()).toEqual([]);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(6);
    db.close();
    db = openSearchDatabase(path);
    expect(db.query("SELECT * FROM search_scopes").all()).toEqual(before);
    expect(db.query("SELECT * FROM search_meta").all()).toEqual(meta);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
