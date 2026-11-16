import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureFrozenSQLiteSource,
  prepareFrozenSQLiteSource,
  verifyFrozenSQLiteSource,
} from "../../src/server/database/migration/snapshot.js";

test("frozen snapshots include committed WAL rows and normalize only a separate copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-db-snapshot-")),
    source = new Database(join(root, "source.sqlite"), { strict: true, create: true });
  try {
    source.exec(
      "PRAGMA journal_mode=WAL;CREATE TABLE data(id INTEGER PRIMARY KEY,body TEXT NOT NULL);INSERT INTO data VALUES(1,'original');",
    );
    const frozen = await captureFrozenSQLiteSource({
      id: "fixture",
      directory: join(root, "frozen"),
      sourcePath: join(root, "source.sqlite"),
    });
    expect(frozen.originalPath).toBe(join(root, "source.sqlite"));
    const copy = new Database(frozen.snapshotPath, { readonly: true });
    expect(copy.query("SELECT body FROM data").get()).toEqual({ body: "original" });
    copy.close();
    const normalized = await prepareFrozenSQLiteSource(frozen, join(root, "normalized.sqlite"), (path) => {
      const db = new Database(path);
      try {
        db.exec("CREATE TABLE metadata(value TEXT);INSERT INTO metadata VALUES('normalized');");
      } finally {
        db.close();
      }
    });
    await verifyFrozenSQLiteSource(frozen);
    await verifyFrozenSQLiteSource(normalized);
    expect(normalized.sha256).not.toBe(frozen.sha256);
    expect(source.query("SELECT name FROM sqlite_master WHERE name='metadata'").get()).toBeNull();
    expect((await lstat(frozen.snapshotPath)).mode & 0o777).toBe(0o400);
    await expect(
      captureFrozenSQLiteSource({
        id: "fixture",
        directory: join(root, "frozen"),
        sourcePath: join(root, "source.sqlite"),
      }),
    ).rejects.toThrow();
    await symlink(join(root, "source.sqlite"), join(root, "link.sqlite"));
    await expect(
      captureFrozenSQLiteSource({ id: "link", directory: join(root, "frozen"), sourcePath: join(root, "link.sqlite") }),
    ).rejects.toThrow("invalidMigrationSnapshot");
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});
