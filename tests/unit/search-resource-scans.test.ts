import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchResourceScans } from "../../src/server/search/storage/resource-scans.js";

const storage = "a".repeat(64),
  name = "b".repeat(64),
  end = { physical: null, allocations: null };

test("duplicate and uncertain manual requests join one durable cycle; completed receipts never restart it", () => {
  const db = openSearchDatabase(":memory:"),
    scans = new SearchResourceScans(db),
    operation = randomUUID();
  try {
    expect(scans.claim(storage, false)).toBeNull();
    expect(scans.view(storage, false).state).toBe("idle");
    scans.request(storage, operation);
    const work = scans.claim(storage, false)!;
    scans.request(storage, operation);
    scans.request(storage, randomUUID());
    expect(scans.claim(storage, false)).toBeNull();
    expect(scans.finish(work, end, [{ name, status: "protected", missing: false }])).toBeTrue();
    scans.request(storage, operation);
    expect(scans.view(storage, false).state).toBe("ready");
    expect(scans.claim(storage, false)).toBeNull();
    scans.request(storage, randomUUID());
    const next = scans.claim(storage, false)!;
    expect(next.epoch).toBe(work.epoch + 1);
    expect(scans.view(storage, false).previous?.summary.protected).toBe(1);
    expect(scans.finish(work, end, [])).toBeFalse();
  } finally {
    db.close();
  }
});

test("partial cursors survive reopening and expired tokens cannot finish, fail or revive old work", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-resource-scans-")),
    path = join(root, "search.sqlite");
  let db = openSearchDatabase(path),
    now = 1000000,
    scans = new SearchResourceScans(db, () => now);
  try {
    scans.request(storage, randomUUID());
    const first = scans.claim(storage, false)!,
      cursor = { physical: name, allocations: null };
    expect(scans.finish(first, cursor, [{ name, status: "protected", missing: false }])).toBeTrue();
    const expired = scans.claim(storage, false)!;
    db.close();
    db = openSearchDatabase(path);
    scans = new SearchResourceScans(db, () => now);
    expect(scans.claim(storage, false)).toBeNull();
    now += 120001;
    expect(scans.heartbeat(expired)).toBeFalse();
    expect(scans.finish(expired, end, [])).toBeFalse();
    scans.fail(expired, "unavailable");
    expect(scans.view(storage, false).state).toBe("queued");
    const resumed = scans.claim(storage, false)!;
    expect(resumed.cursor).toEqual(cursor);
    expect(resumed.epoch).toBe(expired.epoch);
    expect(resumed.token).not.toBe(expired.token);
    expect(scans.finish(resumed, end, [{ name, status: "protected", missing: false }])).toBeTrue();
    expect(scans.view(storage, false).summary).toEqual({
      checked: 1,
      protected: 1,
      retained: 0,
      missing: 0,
      removed: 0,
      failed: 0,
    });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unique observations replace previous counts and retain proven cleanup across duplicate pages", () => {
  const db = openSearchDatabase(":memory:"),
    scans = new SearchResourceScans(db),
    cursor = { physical: name, allocations: name };
  try {
    scans.request(storage, randomUUID());
    expect(
      scans.finish(scans.claim(storage, false)!, cursor, [{ name, status: "unavailable", missing: true }]),
    ).toBeTrue();
    expect(scans.view(storage, false).summary.failed).toBe(1);
    expect(
      scans.finish(scans.claim(storage, false)!, cursor, [{ name, status: "removed", missing: false }]),
    ).toBeTrue();
    expect(scans.finish(scans.claim(storage, false)!, end, [{ name, status: "unowned", missing: true }])).toBeTrue();
    expect(scans.view(storage, false).summary).toEqual({
      checked: 1,
      protected: 0,
      retained: 0,
      missing: 0,
      removed: 1,
      failed: 0,
    });
  } finally {
    db.close();
  }
});

test("unavailable storage backs off and stops after three failures; manual retry preserves the cursor", () => {
  const db = openSearchDatabase(":memory:");
  let now = 1000000;
  const scans = new SearchResourceScans(db, () => now),
    cursor = { physical: name, allocations: null };
  try {
    scans.request(storage, randomUUID());
    scans.finish(scans.claim(storage, false)!, cursor, []);
    for (let i = 0; i < 3; i++) {
      const work = scans.claim(storage, false)!;
      expect(work.cursor).toEqual(cursor);
      scans.fail(work, "unavailable");
      expect(scans.claim(storage, false)).toBeNull();
      now += 1800001;
    }
    expect(scans.claim(storage, true)).toBeNull();
    expect(scans.view(storage, false).nextAt).toBeNull();
    expect(scans.view(storage, true).nextAt).toBeNull();
    scans.request(storage, randomUUID());
    expect(scans.claim(storage, false)?.cursor).toEqual(cursor);
  } finally {
    db.close();
  }
});

test("invalid batches and summary overflow roll back observations and leave the worker claim intact", () => {
  const db = openSearchDatabase(":memory:"),
    scans = new SearchResourceScans(db);
  try {
    scans.request(storage, randomUUID());
    const work = scans.claim(storage, false)!;
    expect(() => scans.finish(work, end, [{ name: "foreign", status: "removed", missing: false }])).toThrow(
      "configuration",
    );
    expect(() => scans.finish(work, end, Array(17).fill({ name, status: "protected", missing: false }))).toThrow(
      "configuration",
    );
    db.query("UPDATE search_resource_scans SET summary=? WHERE storage=?").run(
      JSON.stringify({ checked: 100000, protected: 0, retained: 0, missing: 0, removed: 0, failed: 0 }),
      storage,
    );
    expect(() => scans.finish(work, end, [{ name, status: "protected", missing: false }])).toThrow("limit");
    expect(db.query("SELECT * FROM search_resource_observations").all()).toHaveLength(0);
    expect(scans.heartbeat(work)).toBeTrue();
  } finally {
    db.close();
  }
});

test("schema five upgrade preserves primary configuration and allocations and reopens its durable scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-resource-migration-")),
    path = join(root, "search.sqlite");
  let db = openSearchDatabase(path);
  try {
    db.exec(
      "DROP TABLE search_resource_requests; DROP TABLE search_resource_observations; DROP TABLE search_resource_scans; PRAGMA user_version=5;",
    );
    const before = db.query("SELECT * FROM search_binding").all(),
      sources = db.query("SELECT * FROM search_sources").all();
    db.query("INSERT INTO search_resources VALUES(?,?,?,?,NULL,'building',NULL,NULL,0,NULL,1,1)").run(
      storage,
      name,
      "recipe",
      "marker",
    );
    db.close();
    db = openSearchDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("SELECT * FROM search_binding").all()).toEqual(before);
    expect(db.query("SELECT * FROM search_sources").all()).toEqual(sources);
    expect(db.query("SELECT marker FROM search_resources").get()).toEqual({ marker: "marker" });
    new SearchResourceScans(db).request(storage, randomUUID());
    db.close();
    db = openSearchDatabase(path);
    expect(new SearchResourceScans(db).view(storage, false).state).toBe("queued");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
