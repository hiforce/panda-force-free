import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { workflowFixture as fixture, runWorkflow } from "../support/workflow-fixture.js";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { initializePublicationSchema } from "../../src/server/delivery/storage/schema.js";

function unknown(f: ReturnType<typeof fixture>) {
  f.queue();
  const lease = f.store.leases.acquire()!,
    step = f.store.steps.intent(lease, "post.1", "post.create", { text: "Frozen" }).step;
  f.store.finish(lease, "needsAttention", null, "outcomeUnknown");
  return { lease, step };
}
const report = { status: "match" as const, result: { postId: "123", accountId: "456" }, details: { remoteId: "123" } };
const inspect = (f: ReturnType<typeof fixture>, step: number) => {
  const captured = f.store.recovery.capture("owner", f.input.id, step);
  return f.store.recovery.record("owner", f.input.id, step, captured.stateToken, report);
};

test("recovery stores evidence separately and an explicit adoption never dispatches or rewrites an intent", async () => {
  const f = fixture();
  try {
    const { step } = unknown(f),
      original = f.store.get(f.input.id),
      evidence = inspect(f, step.id);
    expect(f.store.get(f.input.id).phase).toBe("needsAttention");
    expect(f.store.steps.effective(f.input.id)[0]?.outcome).toBe("pending");
    const decision = f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {});
    expect(f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {})).toEqual(decision);
    expect(f.store.get(f.input.id).steps).toEqual(original.steps);
    expect(f.store.get(f.input.id).plan).toEqual(original.plan);
    expect(f.store.get(f.input.id).phase).toBe("failed");
    expect(f.store.leases.acquire()).toBeNull();
    expect(f.store.steps.effective(f.input.id)[0]?.result).toEqual(report.result);
    const reopened = new Database(join(f.root, "jobs.sqlite"));
    try {
      const store = new WorkflowRepository(reopened, "x-post", f.now);
      expect(store.get(f.input.id)).toEqual(f.store.get(f.input.id));
      store.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true);
      let dispatches = 0;
      await runWorkflow(store, {
        authorize() {
          return () => {};
        },
        execute: (_owner, _plan, effects) =>
          effects.run("post.1", "post.create", { text: "Frozen" }, async () => {
            dispatches++;
            return null;
          }),
      });
      expect(dispatches).toBe(0);
      expect(store.get(f.input.id).phase).toBe("completed");
      expect(store.get(f.input.id).steps[0]?.outcome).toBe("pending");
      expect(store.get(f.input.id).resolutions).toEqual([decision]);
    } finally {
      reopened.close();
    }
  } finally {
    f.dispose();
  }
});

test("evidence and decisions are owner-bound, lease-fenced, expiring and atomic", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!,
      step = f.store.steps.intent(lease, "post.1", "post.create", {}).step;
    expect(() => f.store.recovery.capture("owner", f.input.id, step.id)).toThrow("recoveryBusy");
    expect(() => f.store.recovery.capture("other", f.input.id, step.id)).toThrow("notFound");
    f.advance();
    const old = f.store.recovery.capture("owner", f.input.id, step.id);
    const newer = f.store.leases.acquire()!;
    f.store.finish(newer, "needsAttention", null, "outcomeUnknown");
    expect(() => f.store.recovery.record("owner", f.input.id, step.id, old.stateToken, report)).toThrow(
      "recoveryChanged",
    );
    const evidence = inspect(f, step.id);
    expect(() => f.store.recovery.adopt("other", f.input.id, evidence.id, () => {})).toThrow("notFound");
    expect(() =>
      f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {
        throw Error("revoked");
      }),
    ).toThrow("revoked");
    f.db.exec(
      "CREATE TRIGGER fail_recovery BEFORE UPDATE ON publication_jobs BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect(() => f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {})).toThrow("fixture");
    expect(f.store.get(f.input.id).resolutions).toEqual([]);
    f.db.exec("DROP TRIGGER fail_recovery");
    for (let i = 0; i < 10; i++) f.advance();
    expect(() => f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {})).toThrow("recoveryExpired");
    expect(() => f.store.steps.settle(lease, step.id, "succeeded", {}, null)).toThrow("leaseLost");
  } finally {
    f.dispose();
  }
});

test("unavailable and mismatched lookups leave unknown intents blocked", () => {
  const f = fixture();
  try {
    const { step } = unknown(f);
    for (const status of ["mismatch", "unavailable"] as const) {
      const { stateToken } = f.store.recovery.capture("owner", f.input.id, step.id);
      const evidence = f.store.recovery.record("owner", f.input.id, step.id, stateToken, {
        status,
        result: null,
        details: { reason: "platformRejected" },
      });
      expect(() => f.store.recovery.adopt("owner", f.input.id, evidence.id, () => {})).toThrow("recoveryNotMatched");
    }
    expect(f.store.get(f.input.id).recoveryEvidence).toHaveLength(2);
    expect(f.store.get(f.input.id).steps[0]?.outcome).toBe("pending");
    expect(() => f.store.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true)).toThrow("conflict");
  } finally {
    f.dispose();
  }
});

test("competing evidence cannot replace a decision and stopping invalidates an earlier lookup", () => {
  const f = fixture();
  try {
    const { step } = unknown(f),
      first = inspect(f, step.id),
      second = inspect(f, step.id);
    f.store.cancel("owner", f.input.id);
    expect(() => f.store.recovery.adopt("owner", f.input.id, first.id, () => {})).toThrow("recoveryChanged");
    const current = inspect(f, step.id);
    f.store.recovery.adopt("owner", f.input.id, current.id, () => {});
    expect(() => f.store.recovery.adopt("owner", f.input.id, second.id, () => {})).toThrow("conflict");
    expect(f.store.get(f.input.id).phase).toBe("cancelled");
    expect(() => f.store.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true)).toThrow("cancelled");
    expect(f.store.get(f.input.id).resolutions).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test("schema six migration is idempotent and preserves stopped unknown effects", () => {
  const f = fixture();
  try {
    unknown(f);
    f.store.cancel("owner", f.input.id);
    const before = f.store.get(f.input.id);
    f.db.exec(
      "DROP INDEX publications_by_source; ALTER TABLE publication_plans DROP COLUMN sourceProjectId; DROP TABLE publication_successors; DROP TABLE publication_resolutions; DROP TABLE publication_recovery_evidence; UPDATE publication_delivery_schema SET version=6;",
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
