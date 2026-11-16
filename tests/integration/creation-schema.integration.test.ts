import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";

test("existing creation metadata migrates without losing task identity or resetting exhausted attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-creation-migrate-")),
    path = join(directory, "tasks.sqlite");
  let db: Database | undefined;
  try {
    db = openCreationDatabase(path);
    const task = new CreationTaskRepository(db).create(
      {
        schema: 1,
        id: randomUUID(),
        operationId: randomUUID(),
        owner: "owner",
        projectId: "project-1",
        kind: "document",
        target: { parentId: null, treeVersion: 0, locale: "en" },
        inputDigest: "a".repeat(64),
        skillCaptureId: randomUUID(),
      },
      10000,
    );
    db.query("UPDATE creation_tasks SET attempts=4,generation=4 WHERE id=?").run(task.spec.id);
    db.exec(
      "DROP TABLE creation_progress; DROP TABLE creation_actions; DROP TABLE creation_questions; ALTER TABLE creation_tasks DROP COLUMN budget; PRAGMA user_version=1;",
    );
    db.close();
    db = undefined;
    db = openCreationDatabase(path);
    const restored = new CreationTaskRepository(db).get("owner", task.spec.id);
    expect(restored.spec).toEqual(task.spec);
    expect(restored.generation).toBe(4);
    expect(db.query<{ budget: number }, []>("SELECT budget FROM creation_tasks").get()!.budget).toBe(0);
    expect(() => new CreationTaskRepository(db!).claim("owner", task.spec.id, 11000, 30000)).toThrow("unavailable");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT * FROM creation_questions").all()).toEqual([]);
    expect(db.query("SELECT * FROM creation_actions").all()).toEqual([]);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("a newer creation schema is rejected without downgrading its database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-creation-future-")),
    path = join(directory, "tasks.sqlite");
  try {
    const newer = new Database(path);
    newer.exec(
      "PRAGMA user_version=4; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('retained');",
    );
    newer.close();
    expect(() => openCreationDatabase(path)).toThrow("unavailable");
    const retained = new Database(path, { readonly: true });
    try {
      expect(retained.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(retained.query("SELECT value FROM future_data").get()).toEqual({ value: "retained" });
    } finally {
      retained.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
