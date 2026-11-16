import { removeGenerationSourceSchema } from "../support/legacy-knowledge-schema.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { KnowledgeTaskRecords } from "../../src/server/knowledge/storage/records.js";
import { knowledgeTaskHistory } from "../../src/server/knowledge/tasks/history.js";
import { KnowledgeTaskError } from "../../src/server/knowledge/tasks/contracts.js";
import { Database } from "bun:sqlite";

function seed(db: Database, id: string, owner = "alice", project = "project") {
  db.query(
    "INSERT INTO knowledge_tasks(id,owner,project,title,signature,inputDigest,dialogueDigest,state,result,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'completed',?,?,?)",
  ).run(
    id,
    owner,
    project,
    id,
    id,
    "a".repeat(64),
    "b".repeat(64),
    JSON.stringify({ id, version: "a".repeat(64), commit: "b".repeat(40) }),
    1000,
    1001,
  );
}
test("history watermark handles timestamp ties, late arrivals and restart without duplicates or scope crossover", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-knowledge-history-")),
    path = join(root, "knowledge.sqlite");
  let db = openKnowledgeDatabase(path),
    records = new KnowledgeTaskRecords(db);
  const authorize = async () => {};
  try {
    const expected = Array.from({ length: 113 }, (_, i) => "task-" + String(i).padStart(3, "0"));
    db.transaction(() => {
      for (const id of expected) seed(db, id);
      seed(db, "other-owner", "bob");
      seed(db, "other-project", "alice", "other");
      seed(db, "personal-alice", "alice", "personal");
      seed(db, "personal-bob", "bob", "personal");
    }).immediate();
    const first = await knowledgeTaskHistory(
      records,
      { authorize },
      (tasks) => tasks.map((task) => task.id),
      "alice",
      "project",
    );
    expect(first.tasks).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    seed(db, "same-time-late-arrival");
    db.close();
    db = openKnowledgeDatabase(path);
    records = new KnowledgeTaskRecords(db);
    const ids = [...first.tasks];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await knowledgeTaskHistory(
        records,
        { authorize },
        (tasks) => tasks.map((task) => task.id),
        "alice",
        "project",
        cursor,
      );
      ids.push(...page.tasks);
      cursor = page.nextCursor;
    }
    expect(ids).toEqual([...expected].sort().reverse());
    expect(new Set(ids).size).toBe(113);
    await expect(
      knowledgeTaskHistory(
        records,
        { authorize },
        (tasks) => tasks.map((task) => task.id),
        "bob",
        "project",
        first.nextCursor!,
      ),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      knowledgeTaskHistory(
        records,
        { authorize },
        (tasks) => tasks.map((task) => task.id),
        "alice",
        "other",
        first.nextCursor!,
      ),
    ).rejects.toMatchObject({ code: "invalidInput" });
    expect(
      (await knowledgeTaskHistory(records, { authorize }, (tasks) => tasks.map((task) => task.id), "alice", "personal"))
        .tasks,
    ).toEqual(["personal-alice"]);
    expect(
      (await knowledgeTaskHistory(records, { authorize }, (tasks) => tasks.map((task) => task.id), "bob", "personal"))
        .tasks,
    ).toEqual(["personal-bob"]);
    const plan = db
      .query<{ detail: string }, [string, string]>(
        "EXPLAIN QUERY PLAN SELECT * FROM knowledge_tasks WHERE owner=? AND project=? ORDER BY createdAt DESC,id DESC LIMIT 51",
      )
      .all("alice", "project");
    expect(plan.some((row) => row.detail.includes("knowledge_history_page"))).toBeTrue();
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBeFalse();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("history reauthorizes before returning and rejects missing watermark anchors", async () => {
  const db = openKnowledgeDatabase(":memory:"),
    records = new KnowledgeTaskRecords(db);
  try {
    for (let i = 0; i < 52; i++) seed(db, "task-" + i);
    const first = await knowledgeTaskHistory(
      records,
      { authorize: async () => {} },
      (tasks) => tasks.map((task) => task.id),
      "alice",
      "project",
    );
    let reads = 0;
    await expect(
      knowledgeTaskHistory(
        records,
        {
          authorize: async () => {
            if (++reads === 2) throw new KnowledgeTaskError("notFound", 404);
          },
        },
        (tasks) => tasks.map((task) => task.id),
        "alice",
        "project",
      ),
    ).rejects.toMatchObject({ status: 404 });
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
    db.query("DELETE FROM knowledge_tasks WHERE id=?").run(decoded.position.watermark.id);
    await expect(
      knowledgeTaskHistory(
        records,
        { authorize: async () => {} },
        (tasks) => tasks.map((task) => task.id),
        "alice",
        "project",
        first.nextCursor!,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    for (const cursor of ["!invalid", "e30", "A".repeat(1001)])
      await expect(
        knowledgeTaskHistory(
          records,
          { authorize: async () => {} },
          (tasks) => tasks.map((task) => task.id),
          "alice",
          "project",
          cursor,
        ),
      ).rejects.toMatchObject({ code: "invalidInput" });
  } finally {
    db.close();
  }
});
test("schema6 history upgrade adds an index without changing workflow rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-history-migration-")),
    path = join(root, "knowledge.sqlite");
  let db = openKnowledgeDatabase(path);
  try {
    seed(db, "preserved");
    const before = db.query("SELECT * FROM knowledge_tasks").all();
    removeGenerationSourceSchema(db);
    db.exec("DROP INDEX knowledge_history_page; PRAGMA user_version=6;");
    db.close();
    db = openKnowledgeDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(db.query("SELECT * FROM knowledge_tasks").all()).toEqual(before);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='knowledge_history_page'").get()).not.toBeNull();
    removeGenerationSourceSchema(db);
    db.exec(
      "DROP INDEX knowledge_history_page; PRAGMA user_version=6; CREATE TABLE knowledge_history_page(conflict TEXT);",
    );
    db.close();
    expect(() => openKnowledgeDatabase(path)).toThrow();
    db = new Database(path, { readonly: true, create: false });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("SELECT * FROM knowledge_tasks").all()).toEqual(before);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
