import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import type { KnowledgeExecution } from "../../src/server/knowledge/tasks/contracts.js";

const databases: Database[] = [];
function fixture() {
  const db = openKnowledgeDatabase(":memory:");
  databases.push(db);
  const ledger = knowledgeTaskLedger(db);
  let createdAt = 1000;
  const create = (operationId = "op-1", owner = "alice", signature = "context-1", requestHash = "request-1") =>
    ledger.create(
      {
        owner,
        project: "p1",
        title: "Selected document",
        operationId,
        requestHash,
        signature,
        inputDigest: "input-file-hash",
        dialogueDigest: "dialogue-file-hash",
      },
      createdAt++,
    );
  const claim = (now = 1001) => {
    const result = ledger.claim(now, 1000)!;
    return { ...result, scope: ledger.bind(result.lease, { sessionId: "s1", runId: "r1" }, now) };
  };
  return { db, ledger, create, claim };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("durable knowledge execution", () => {
  test("submission receipts remain idempotent after a deduplicated task ends", () => {
    const { ledger, create } = fixture();
    const first = create();
    expect(create("op-2").id).toBe(first.id);
    ledger.cancel("alice", first.id, 1002);
    expect(create("op-2").id).toBe(first.id);
    expect(() => create("op-2", "alice", "context-1", "different-request")).toThrow("conflict");
    expect(create("op-3").id).not.toBe(first.id);
    expect(() => ledger.get("bob", first.id)).toThrow("notFound");
  });

  test("one owner cannot claim overlapping background tasks", () => {
    const { ledger, create, claim } = fixture();
    create();
    create("op-2", "alice", "different-context");
    create("op-1", "bob");
    const first = claim();
    const second = ledger.claim(1002, 1000)!;
    expect(first.task.owner).toBe("alice");
    expect(second.task.owner).toBe("bob");
    expect(ledger.claim(1003, 1000)).toBeNull();
  });

  test("expired execution is fenced before a replacement starts", () => {
    const { ledger, create, claim } = fixture();
    create();
    const old = claim();
    expect(() => ledger.draft(old.scope, "late-draft", 2001)).toThrow("leaseLost");
    const replacement = ledger.claim(2002, 1000)!;
    expect(replacement.lease.generation).toBe(old.lease.generation + 1);
    expect(() => ledger.heartbeat(old.lease, 2003, 1000)).toThrow("leaseLost");
    expect(ledger.fail(old.lease, "interrupted", 2003)).toBeFalse();
    expect(ledger.get("alice", old.task.id).state).toBe("running");
  });

  test("run identities cannot be rebound or borrowed", () => {
    const { ledger, create, claim } = fixture();
    create();
    const run = claim();
    expect(() => ledger.bind(run.lease, { sessionId: "other", runId: "r1" }, 1002)).toThrow("leaseLost");
    expect(() => ledger.draft({ ...run.scope, runId: "other" }, "draft", 1002)).toThrow("leaseLost");
  });

  test("cancelled runs cannot submit a late draft or question", () => {
    const { ledger, create, claim } = fixture();
    const task = create(),
      run = claim();
    ledger.cancel("alice", task.id, 1002);
    expect(() => ledger.draft(run.scope, "late", 1003)).toThrow("leaseLost");
    expect(() => ledger.question(run.scope, "late", 1003)).toThrow("leaseLost");
    expect(ledger.fail(run.lease, "invalidOutput", 1003)).toBeFalse();
  });

  test("durable questions free the owner and stale answers cannot replace newer dialogue", () => {
    const { ledger, create, claim } = fixture();
    const first = create();
    create("op-2", "alice", "other-context");
    const run = claim();
    ledger.question(run.scope, "question-file", 1002);
    expect(ledger.get("alice", first.id).state).toBe("waiting");
    expect(ledger.claim(1003, 1000)?.task.id).not.toBe(first.id);
    expect(() => ledger.answer("alice", first.id, "old-dialogue", "new-answer", 1004)).toThrow("conflict");
    ledger.answer("alice", first.id, "question-file", "answer-file", 1004);
    expect(() => ledger.answer("alice", first.id, "question-file", "late-answer", 1005)).toThrow("conflict");
  });

  test("review edits use optimistic revisions and admission owns crash recovery", () => {
    const { ledger, create, claim } = fixture();
    const task = create(),
      run = claim();
    ledger.draft(run.scope, "draft-1", 1002);
    ledger.edit("alice", task.id, 1, "draft-2", 1003);
    expect(() => ledger.edit("alice", task.id, 1, "late-edit", 1004)).toThrow("conflict");
    expect(() => ledger.admit("alice", task.id, 1, "old-result", 1004)).toThrow("conflict");
    ledger.admit("alice", task.id, 2, "approved-output", 1004);
    expect(ledger.nextOutput()?.outputDigest).toBe("approved-output");
    expect(() => ledger.cancel("alice", task.id, 1005)).toThrow("conflict");
    const receipt = { id: "knowledge-1", version: "v1", commit: "git-1" };
    ledger.complete("alice", task.id, "approved-output", receipt, 1006);
    ledger.complete("alice", task.id, "approved-output", receipt, 1007);
    expect(ledger.nextOutput()).toBeNull();
    expect(ledger.get("alice", task.id).result).toEqual(receipt);
  });

  test("repeated crashes exhaust bounded attempts", () => {
    const { ledger, create } = fixture();
    const task = create();
    for (let n = 0; n < 3; n++) expect(ledger.claim(1001 + n * 1001, 1000)).not.toBeNull();
    expect(ledger.claim(5005, 1000)).toBeNull();
    expect(ledger.get("alice", task.id).state).toBe("failed");
  });

  test("question rounds and failure retries have separate finite budgets", () => {
    const { ledger, create } = fixture();
    const task = create();
    for (let n = 0; n < 8; n++) {
      const run = ledger.claim(1001 + n * 10, 1000)!;
      const scope: KnowledgeExecution = ledger.bind(run.lease, { sessionId: "s" + n, runId: "r" + n }, 1002 + n * 10);
      ledger.question(scope, "q" + n, 1003 + n * 10);
      ledger.answer("alice", task.id, "q" + n, "answer" + n, 1004 + n * 10);
    }
    const run = ledger.claim(1100, 1000)!;
    const scope = ledger.bind(run.lease, { sessionId: "s9", runId: "r9" }, 1100);
    expect(() => ledger.question(scope, "ninth-question", 1101)).toThrow("budget");
    ledger.draft(scope, "final-draft", 1102);
    expect(ledger.get("alice", task.id).state).toBe("review");
  });

  test("the database stores digests rather than source, question or draft bodies", () => {
    const { db, create } = fixture();
    create();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(knowledge_tasks)")
      .all()
      .map((column) => column.name);
    for (const body of ["text", "prompt", "content", "question", "answer", "draft", "sources"])
      expect(columns).not.toContain(body);
  });
});

test("SQLite rejects an asynchronous admission guard without retaining a task or operation receipt", async () => {
  const { ledger } = fixture(),
    input = {
      owner: "alice",
      project: "p1",
      title: "Selected document",
      operationId: "async-guard",
      requestHash: "request",
      signature: "signature",
      inputDigest: "input",
      dialogueDigest: "dialogue",
    };
  expect(() =>
    ledger.create(input, 1000, async () => {
      await Promise.resolve();
      throw Error("guard rejected");
    }),
  ).toThrow("unavailable");
  await Promise.resolve();
  expect(ledger.submission(input.owner, input.operationId, input.requestHash)).toBeNull();
  expect(ledger.list(input.owner, input.project)).toEqual([]);
});
