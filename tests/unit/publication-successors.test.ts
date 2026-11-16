import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { workflowFixture as fixture, runWorkflow } from "../support/workflow-fixture.js";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { initializePublicationSchema } from "../../src/server/delivery/storage/schema.js";
import { digest } from "../../src/server/delivery/digest.js";

test("a successor inherits confirmed effects by reference while preserving every predecessor receipt and plan byte", async () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!;
    const first = f.store.steps.intent(lease, "post.1", "post.create", { text: "First" }).step;
    f.store.steps.settle(lease, first.id, "succeeded", { postId: "123" }, null);
    const second = f.store.steps.intent(lease, "post.2", "post.create", { text: "Second" }).step;
    f.store.steps.settle(lease, second.id, "rejected", null, "rateLimited");
    f.store.finish(lease, "failed", null, "rateLimited");
    const parent = f.store.get(f.input.id),
      bytes = f.db.query("SELECT record FROM publication_plans WHERE id=?").get(f.input.id);
    f.advance(86400001);
    const child = f.store.lineage.create(
      "owner",
      f.input.id,
      parent.continuationToken,
      { ...f.input, id: randomUUID() },
      () => {},
    );
    expect(child.phase).toBe("prepared");
    expect(child.confirmations).toEqual([]);
    expect(child.steps).toEqual([]);
    expect(child.lineage.steps).toHaveLength(1);
    expect(child.lineage.steps[0]).toEqual({ ...parent.steps[0]!, sourceJobId: f.input.id, resolution: null });
    expect(child.lineage.confirmations).toBe(1);
    expect(f.store.get(f.input.id).steps).toEqual(parent.steps);
    expect(f.store.get(f.input.id).confirmations).toEqual(parent.confirmations);
    expect(f.db.query("SELECT record FROM publication_plans WHERE id=?").get(f.input.id)).toEqual(bytes);
    expect(f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID() }).plan.id).toBe(child.plan.id);
    expect(() => f.store.queue("owner", f.input.id, parent.plan.fingerprint, () => {}, true)).toThrow("planSuperseded");
    expect(f.store.leases.acquire()).toBeNull();
    const db = new Database(join(f.root, "jobs.sqlite"));
    try {
      const store = new WorkflowRepository(db, "x-post", f.now),
        calls: string[] = [];
      store.queue("owner", child.plan.id, child.plan.fingerprint, () => {});
      await runWorkflow(store, {
        authorize() {
          return () => {};
        },
        async execute(_owner, _plan, effects) {
          expect(effects.inspect().confirmation).toBe(2);
          const a = await effects.run("post.1", "post.create", { text: "First" }, async () => {
            calls.push("first");
            return null;
          });
          const b = await effects.run("post.2", "post.create", { text: "Second" }, async () => {
            calls.push("second");
            return { postId: "124" };
          });
          return { posts: [a, b] };
        },
      });
      expect(calls).toEqual(["second"]);
      expect(store.get(child.plan.id).phase).toBe("completed");
      expect(store.get(child.plan.id).steps).toHaveLength(1);
      expect(store.get(f.input.id).steps).toEqual(parent.steps);
    } finally {
      db.close();
    }
  } finally {
    f.dispose();
  }
});

test("stopped unknown effects block successors until an explicit resolution exists", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!,
      pending = f.store.steps.intent(lease, "post.1", "post.create", {}).step;
    f.store.finish(lease, "needsAttention", null, "outcomeUnknown");
    const before = f.store.get(f.input.id);
    f.store.cancel("owner", f.input.id);
    expect(() =>
      f.store.lineage.create("owner", f.input.id, before.continuationToken, { ...f.input, id: randomUUID() }, () => {}),
    ).toThrow("recoveryChanged");
    const stopped = f.store.get(f.input.id);
    expect(() =>
      f.store.lineage.create(
        "owner",
        f.input.id,
        stopped.continuationToken,
        { ...f.input, id: randomUUID() },
        () => {},
      ),
    ).toThrow("outcomeUnknown");
    const snapshot = f.store.recovery.capture("owner", f.input.id, pending.id),
      evidence = f.store.recovery.record("owner", f.input.id, pending.id, snapshot.stateToken, {
        status: "match",
        result: { postId: "123" },
        details: { fixture: true },
      });
    f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {});
    const parent = f.store.get(f.input.id),
      input = { ...f.input, id: randomUUID() },
      child = f.store.lineage.create("owner", f.input.id, parent.continuationToken, input, () => {});
    expect(f.store.lineage.create("owner", f.input.id, parent.continuationToken, input, () => {})).toEqual(child);
    expect(
      f.store.lineage.create("owner", f.input.id, parent.continuationToken, { ...input, id: randomUUID() }, () => {})
        .plan.id,
    ).toBe(child.plan.id);
    expect(child.cancellation).toBeNull();
    expect(child.lineage.steps[0]?.resolution?.evidenceId).toBe(evidence.id);
    expect(f.store.get(f.input.id).steps[0]?.outcome).toBe("pending");
    expect(f.store.get(f.input.id).cancellation).toEqual(stopped.cancellation);
    expect(() => f.store.lineage.create("other", f.input.id, parent.continuationToken, input, () => {})).toThrow(
      "notFound",
    );
  } finally {
    f.dispose();
  }
});

test("a failed successor transaction rolls back both the new plan and semantic identity transfer", () => {
  const f = fixture();
  try {
    const input = { ...f.input, id: randomUUID() };
    f.db.exec(
      "CREATE TRIGGER fail_successor BEFORE INSERT ON publication_successors BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect(() => f.store.lineage.create("owner", f.input.id, f.record.continuationToken, input, () => {})).toThrow(
      "fixture",
    );
    expect(f.store.get(f.input.id)).toEqual(f.record);
    expect(() => f.store.get(input.id)).toThrow("notFound");
    expect(f.store.prepare("owner", digest("identity"), { ...input }).plan.id).toBe(f.input.id);
    f.db.exec("DROP TRIGGER fail_successor");
    f.queue();
    const live = f.store.get(f.input.id);
    expect(() => f.store.lineage.create("owner", f.input.id, live.continuationToken, input, () => {})).toThrow(
      "recoveryBusy",
    );
    expect(f.db.query("SELECT count(*) AS n FROM publication_successors").get()).toEqual({ n: 0 });
  } finally {
    f.dispose();
  }
});

test("lineage is bounded and refuses cycles and altered ancestor snapshots", () => {
  const f = fixture();
  try {
    let parent = f.record;
    for (let i = 0; i < 16; i++)
      parent = f.store.lineage.create(
        "owner",
        parent.plan.id,
        parent.continuationToken,
        { ...f.input, id: randomUUID() },
        () => {},
      );
    expect(parent.lineage.depth).toBe(16);
    expect(parent.lineage.rootId).toBe(f.input.id);
    expect(() =>
      f.store.lineage.create(
        "owner",
        parent.plan.id,
        parent.continuationToken,
        { ...f.input, id: randomUUID() },
        () => {},
      ),
    ).toThrow("historyFull");
    const original = f.db
      .query<{ record: string }, [string]>("SELECT record FROM publication_plans WHERE id=?")
      .get(f.input.id)!.record;
    const corrupt = JSON.parse(original);
    corrupt.payload = {};
    f.db.query("UPDATE publication_plans SET record=? WHERE id=?").run(JSON.stringify(corrupt), f.input.id);
    expect(() => f.store.get(parent.plan.id)).toThrow("invalidSnapshot");
    f.db.query("UPDATE publication_plans SET record=? WHERE id=?").run(original, f.input.id);
    f.db
      .query("INSERT INTO publication_successors VALUES(?,?,?,?,?,?)")
      .run(parent.plan.id, f.input.id, "owner", f.now(), parent.plan.fingerprint, parent.continuationToken);
    expect(() => f.store.get(parent.plan.id)).toThrow("invalidSnapshot");
  } finally {
    f.dispose();
  }
});

test("schema seven upgrades twice without altering existing recovery evidence or raw intents", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!,
      step = f.store.steps.intent(lease, "post.1", "post.create", {}).step;
    f.store.finish(lease, "needsAttention", null, "outcomeUnknown");
    const snapshot = f.store.recovery.capture("owner", f.input.id, step.id);
    f.store.recovery.record("owner", f.input.id, step.id, snapshot.stateToken, {
      status: "unavailable",
      result: null,
      details: {},
    });
    const before = f.store.get(f.input.id);
    f.db.exec(
      "DROP INDEX publications_by_source; ALTER TABLE publication_plans DROP COLUMN sourceProjectId; DROP TABLE publication_successors; UPDATE publication_delivery_schema SET version=7;",
    );
    initializePublicationSchema(f.db);
    initializePublicationSchema(f.db);
    expect(f.store.get(f.input.id)).toEqual(before);
    expect(f.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.dispose();
  }
});
