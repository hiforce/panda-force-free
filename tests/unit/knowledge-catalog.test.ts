import { expect, test } from "bun:test";
import { removeGenerationBudgetSchema } from "../support/legacy-knowledge-schema.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { KnowledgeCatalogStore } from "../../src/server/knowledge/storage/catalog.js";
import type { KnowledgeCatalogProjection } from "../../src/server/knowledge/catalog/contracts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function fixture(path = ":memory:") {
  const db = openKnowledgeDatabase(path),
    ledger = knowledgeTaskLedger(db),
    catalog = new KnowledgeCatalogStore(db);
  let time = 1000;
  function complete(owner: string, project: string) {
    const id = ++time,
      task = ledger.create(
        {
          owner,
          project,
          title: "Metadata",
          operationId: "op-" + id,
          requestHash: "r".repeat(64),
          signature: "sig-" + id,
          inputDigest: "a".repeat(64),
          dialogueDigest: "b".repeat(64),
        },
        time,
      ),
      lease = ledger.claim(++time, 10000)!,
      execution = ledger.bind(lease.lease, { sessionId: "s-" + id, runId: "r-" + id }, ++time),
      projection: KnowledgeCatalogProjection = {
        schema: 1,
        id: "knowledge",
        version: "c".repeat(64),
        taskId: task.id,
        sourceCommit: "d".repeat(40),
        recordBlob: "e".repeat(40),
        markdownBlob: "f".repeat(40),
        sources: [{ id: "original", version: "saved1", blob: "a".repeat(40) }],
      },
      receipt = { id: projection.id, version: projection.version, commit: "b".repeat(40) },
      admission = {
        taskId: task.id,
        owner,
        project,
        outputDigest: "d".repeat(64),
        inputDigest: task.inputDigest,
        receipt,
      };
    ledger.draft(execution, "draft", ++time);
    ledger.admit(owner, task.id, 1, admission.outputDigest, ++time);
    ledger.complete(owner, task.id, admission.outputDigest, receipt, ++time, projection);
    return { admission, projection };
  }
  return { db, ledger, catalog, complete };
}
test("personal catalogs isolate owners while project knowledge does not depend on another owner's task endpoint", () => {
  const f = fixture();
  try {
    const alice = f.complete("alice", "personal"),
      bob = f.complete("bob", "personal"),
      shared = f.complete("alice", "project");
    expect(f.catalog.list("alice", "personal").entries.map((item) => item.taskId)).toEqual([alice.admission.taskId]);
    expect(f.catalog.list("bob", "personal").entries.map((item) => item.taskId)).toEqual([bob.admission.taskId]);
    expect(f.catalog.list("bob", "project").entries.map((item) => item.taskId)).toEqual([shared.admission.taskId]);
    expect(f.ledger.list("bob", "project")).toEqual([]);
    expect(f.catalog.current({ ...alice.admission, owner: "bob" })).toBeNull();
    expect(f.catalog.lookup("bob", "personal", [alice.admission.taskId]).entries).toEqual([]);
    expect(f.catalog.lookup("bob", "project", [shared.admission.taskId]).entries).toHaveLength(1);
    expect(f.catalog.lookup("alice", "different", [shared.admission.taskId]).entries).toEqual([]);
    expect(
      f.catalog.save(
        { ...alice.admission, receipt: { ...alice.admission.receipt, commit: "c".repeat(40) } },
        alice.projection,
      ),
    ).toBeFalse();
  } finally {
    f.db.close();
  }
});
test("bounded catalog pages advance past malformed admissions and exclude other scopes", () => {
  const f = fixture();
  try {
    const a = f.complete("alice", "project"),
      b = f.complete("bob", "project");
    f.complete("alice", "personal");
    f.db.query("UPDATE knowledge_tasks SET result='{' WHERE id=?").run(a.admission.taskId);
    const first = f.catalog.page("member", "project", "", 1);
    expect(first.scanned).toBe(1);
    expect(first.next).not.toBeNull();
    const last = f.catalog.page("member", "project", first.next!, 1);
    expect(last.next).toBeNull();
    expect(last.scanned).toBe(1);
    expect(first.entries.concat(last.entries).map((v) => v.taskId)).toEqual([b.admission.taskId]);
    expect(first.incomplete || last.incomplete).toBeTrue();
    expect(() => f.catalog.page("alice", "project", "", 129)).toThrow();
    expect(() => f.catalog.page("alice", "project", "../invalid", 1)).toThrow();
    expect(() => f.catalog.lookup("alice", "project", Array(1001).fill("id"))).toThrow();
  } finally {
    f.db.close();
  }
});
test("damaged admission metadata remains incomplete and cannot block the scan cursor", () => {
  const f = fixture();
  try {
    const { admission } = f.complete("alice", "project");
    f.db.query("UPDATE knowledge_tasks SET result='{' WHERE id=?").run(admission.taskId);
    expect(f.catalog.list("alice", "project")).toMatchObject({ entries: [], incomplete: true, missing: [] });
    const scanned = f.catalog.candidates("");
    expect(scanned.invalid).toBe(1);
    expect(scanned.cursor).toBe(admission.taskId);
    expect(f.catalog.candidates(scanned.cursor).admissions).toEqual([]);
  } finally {
    f.db.close();
  }
});
test("catalog schema upgrade preserves every workflow field and can reconstruct old completed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-catalog-migration-")),
    path = join(root, "knowledge.sqlite");
  let f = fixture(path);
  try {
    const value = f.complete("alice", "project"),
      before = f.ledger.get("alice", value.admission.taskId);
    removeGenerationBudgetSchema(f.db);
    f.db.exec(`DROP TABLE knowledge_generation_origins; DROP TABLE knowledge_generation_jobs;
      DROP TABLE knowledge_generation_usage; DROP TABLE knowledge_generation_policies;
      DROP TABLE knowledge_catalog; DROP INDEX knowledge_completed_project; PRAGMA user_version=2;`);
    f.db.close();
    f = fixture(path);
    expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(f.ledger.get("alice", value.admission.taskId)).toEqual(before);
    expect(f.catalog.list("alice", "project").incomplete).toBeTrue();
    expect(f.catalog.save(value.admission, value.projection)).toBeTrue();
    expect(f.catalog.list("alice", "project").entries).toHaveLength(1);
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
