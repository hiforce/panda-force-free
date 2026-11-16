import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../../src/server/knowledge/storage/generation-queue.js";
import { KnowledgeGenerationAdmission } from "../../src/server/knowledge/storage/generation-admission.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import { removeGenerationSourceSchema } from "../support/legacy-knowledge-schema.js";

function snapshot(db: Database) {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(({ name }) => ({
      name,
      columns: db
        .query<{ name: string }, []>('PRAGMA table_info("' + name + '")')
        .all()
        .map((row) => row.name),
      rows: db.query('SELECT * FROM "' + name + '" ORDER BY rowid').all(),
    }));
}
test("schema7 source migration preserves every old row, operation and document policy, and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-source-kind-migration-")),
    path = join(root, "knowledge.sqlite");
  let db = openKnowledgeDatabase(path);
  try {
    const ledger = knowledgeTaskLedger(db),
      policies = new KnowledgeGenerationPolicies(db, ledger),
      queue = new KnowledgeGenerationQueue(db, ledger),
      admission = new KnowledgeGenerationAdmission(db),
      selection = { ...defaultGenerationPolicy().selection, all: true };
    policies.configure(
      "alice",
      "p1",
      { ...defaultGenerationPolicy(), enabled: true, purpose: "Legacy source", selection, backfill: true },
      { commit: "commit", documents: [{ id: "doc-1", parentId: null, version: "blob" }] },
      1000,
    );
    const lease = queue.claim(3000)!,
      task = ledger.create(
        {
          owner: "alice",
          project: "p1",
          title: "Original",
          operationId: lease.operationId,
          requestHash: "request",
          signature: "signature",
          inputDigest: "input",
          dialogueDigest: "dialogue",
        },
        3000,
        (id, created, now) => admission.admit(lease, id, created, now),
      ),
      origin = ledger.get("alice", task.id).origin;
    removeGenerationSourceSchema(db);
    db.exec("PRAGMA user_version=7");
    const before = snapshot(db),
      policyBytes = db.query("SELECT selection FROM knowledge_generation_policies").get();
    db.close();
    db = openKnowledgeDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    for (const table of before)
      expect(
        db
          .query(
            "SELECT " +
              table.columns.map((name) => '"' + name + '"').join(",") +
              ' FROM "' +
              table.name +
              '" ORDER BY rowid',
          )
          .all(),
      ).toEqual(table.rows);
    expect(db.query("SELECT sourceKind FROM knowledge_generation_jobs").get()).toEqual({ sourceKind: "document" });
    expect(db.query("SELECT sourceKind FROM knowledge_generation_origins").get()).toEqual({ sourceKind: "document" });
    expect(db.query("SELECT selection FROM knowledge_generation_policies").get()).toEqual(policyBytes);
    expect(knowledgeTaskLedger(db).get("alice", task.id).origin).toEqual(origin);
    const migrated = snapshot(db);
    db.close();
    db = openKnowledgeDatabase(path);
    expect(snapshot(db)).toEqual(migrated);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a source migration failure rolls back the first ALTER and leaves schema7 metadata and version intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-source-migration-fail-")),
    path = join(root, "knowledge.sqlite");
  let db = openKnowledgeDatabase(path);
  try {
    removeGenerationSourceSchema(db);
    db.exec("PRAGMA user_version=7; ALTER TABLE knowledge_generation_origins ADD COLUMN sourceKind TEXT;");
    const before = snapshot(db);
    db.close();
    expect(() => openKnowledgeDatabase(path)).toThrow();
    db = new Database(path, { readonly: true, create: false });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(snapshot(db)).toEqual(before);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
