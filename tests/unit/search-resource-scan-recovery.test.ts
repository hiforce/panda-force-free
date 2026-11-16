import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchResourceScans } from "../../src/server/search/storage/resource-scans.js";

const storage = "a".repeat(64),
  name = "b".repeat(64),
  other = "c".repeat(64),
  end = { physical: null, allocations: null },
  initial = { physical: "", allocations: "" };

test("damaged derived scan fields restart a fenced cycle and preserve primary records, ownership and receipts", () => {
  const damaged: [string, string | number][] = [
    ["cursor", "{"],
    ["summary", '{"checked":-1}'],
    ["previous", "unreadable"],
    ["state", "invented"],
    ["token", "not-a-token"],
    ["epoch", 0],
    ["epoch", Number.MAX_SAFE_INTEGER],
    ["leaseUntil", -1],
    ["nextAt", "invalid"],
    ["batches", -1],
    ["startedAt", -1],
    ["checkedAt", -1],
    ["completedAt", -1],
    ["attempts", 99],
    ["failure", "unknown"],
    ["summary", "x".repeat(1025)],
  ];
  for (const [column, value] of damaged) {
    const db = openSearchDatabase(":memory:"),
      scans = new SearchResourceScans(db, () => 1000000),
      operation = randomUUID();
    try {
      db.query("INSERT INTO search_resources VALUES(?,?,?,?,NULL,'building',NULL,NULL,0,NULL,1,1)").run(
        storage,
        name,
        "recipe",
        "marker",
      );
      db.query("INSERT INTO search_meta VALUES('unverified-index-references','damaged-but-protective')").run();
      const binding = db.query("SELECT * FROM search_binding").all(),
        sources = db.query("SELECT * FROM search_sources").all(),
        allocations = db.query("SELECT * FROM search_resources").all();
      scans.request(storage, operation);
      const stale = scans.claim(storage, false)!;
      db.query("UPDATE search_resource_scans SET " + column + "=? WHERE storage=?").run(value, storage);
      expect(scans.view(storage, false).state).toBe("queued");
      expect(scans.heartbeat(stale)).toBeFalse();
      expect(scans.finish(stale, end, [])).toBeFalse();
      scans.fail(stale, "forbidden");
      const recovered = scans.claim(storage, false)!;
      expect(recovered.token).not.toBe(stale.token);
      expect(recovered.cursor).toEqual(initial);
      expect(scans.finish(recovered, end, [{ name, status: "unowned", missing: false }])).toBeTrue();
      scans.request(storage, operation);
      expect(scans.view(storage, false).state).toBe("ready");
      expect(db.query("SELECT * FROM search_binding").all()).toEqual(binding);
      expect(db.query("SELECT * FROM search_sources").all()).toEqual(sources);
      expect(db.query("SELECT * FROM search_resources").all()).toEqual(allocations);
      expect(db.query("SELECT value FROM search_meta WHERE id='unverified-index-references'").get()).toEqual({
        value: "damaged-but-protective",
      });
      expect(db.query("SELECT count(*) n FROM search_resource_requests").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }
});

test("repaired scan and valid previous report survive reopening without rewriting unchanged metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-scan-repair-")),
    path = join(root, "search.sqlite");
  let db = openSearchDatabase(path),
    scans = new SearchResourceScans(db, () => 1000000);
  try {
    scans.request(storage, randomUUID(), "rotated");
    scans.finish(scans.claim(storage, false)!, end, [{ name, status: "protected", missing: false }]);
    scans.request(storage, randomUUID(), "rotated");
    const previous = scans.view(storage, false).previous;
    db.query("UPDATE search_resource_scans SET cursor='invalid' WHERE storage=?").run(storage);
    expect(scans.view(storage, false).previous).toEqual(previous);
    expect(scans.connection(storage)).toBe("rotated");
    const before = db.query("SELECT total_changes() n").get();
    for (let i = 0; i < 10; i++) expect(scans.view(storage, false).state).toBe("queued");
    expect(db.query("SELECT total_changes() n").get()).toEqual(before);
    db.close();
    db = openSearchDatabase(path);
    scans = new SearchResourceScans(db, () => 1000000);
    expect(scans.view(storage, false).previous).toEqual(previous);
    expect(scans.connection(storage)).toBe("rotated");
    expect(scans.claim(storage, false)?.cursor).toEqual(initial);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid observations discard the whole derived batch and fence its token before any new observation writes", () => {
  const db = openSearchDatabase(":memory:"),
    scans = new SearchResourceScans(db);
  try {
    scans.request(storage, randomUUID());
    scans.finish(scans.claim(storage, false)!, { physical: name, allocations: name }, [
      { name, status: "protected", missing: false },
    ]);
    const stale = scans.claim(storage, false)!;
    db.query("UPDATE search_resource_observations SET missing=2 WHERE storage=? AND epoch=?").run(storage, stale.epoch);
    expect(
      scans.finish(stale, end, [
        { name: other, status: "retained", missing: false },
        { name, status: "removed", missing: false },
      ]),
    ).toBeFalse();
    expect(db.query("SELECT name FROM search_resource_observations ORDER BY name").all()).toEqual([{ name }]);
    expect(scans.heartbeat(stale)).toBeFalse();
    expect(scans.claim(storage, false)?.cursor).toEqual(initial);
    expect(db.query("SELECT count(*) n FROM search_meta WHERE id LIKE 'resource-scan-recovery:%'").get()).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
});
