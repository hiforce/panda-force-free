import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { WorkflowWorker } from "../../src/server/delivery/workflows/worker.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import { initializePublicationSchema } from "../../src/server/delivery/storage/schema.js";
import { workflowFixture as fixture, runWorkflow as run } from "../support/workflow-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("stop requests are owned, durable, idempotent and do not rewrite the frozen plan", () => {
  for (const queued of [false, true]) {
    const f = fixture();
    try {
      if (queued) f.queue();
      expect(() => f.store.cancel("other", f.input.id)).toThrow("notFound");
      expect(() => new WorkflowRepository(f.db, "other", f.now).cancel("owner", f.input.id)).toThrow("notFound");
      const stopped = f.store.cancel("owner", f.input.id);
      expect(stopped.phase).toBe("cancelled");
      expect(stopped.cancellation).toEqual({ actor: "owner", requestedAt: f.now() });
      expect(stopped.plan).toEqual(f.record.plan);
      expect(f.store.leases.acquire()).toBeNull();
      f.advance();
      expect(f.store.cancel("owner", f.input.id)).toEqual(stopped);
      const reopened = new Database(join(f.root, "jobs.sqlite"));
      try {
        const store = new WorkflowRepository(reopened, "x-post", f.now);
        expect(store.get(f.input.id)).toEqual(stopped);
        expect(() => store.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true)).toThrow("cancelled");
      } finally {
        reopened.close();
      }
    } finally {
      f.dispose();
    }
  }
});

test("stopping an in-flight Thread preserves its response and prevents the next post for every outcome", async () => {
  for (const outcome of ["succeeded", "rejected", "unknown"] as const) {
    const f = fixture(),
      started = deferred(),
      response = deferred(),
      calls: string[] = [],
      errors: string[] = [];
    const worker = new WorkflowWorker(
      f.store,
      {
        authorize() {
          return () => {};
        },
        async execute(_owner, _plan, effects) {
          const first = await effects.run("first", "post.create", { text: "First" }, async () => {
            calls.push("first");
            started.resolve();
            await response.promise;
            if (outcome !== "succeeded") throw new RemoteOperationError("platformUnavailable", outcome);
            return { postId: "123", accountId: "456" };
          });
          await effects.run("second", "post.create", { text: "Second" }, async () => {
            calls.push("second");
            return null;
          });
          return first;
        },
      },
      (code) => errors.push(code),
    );
    try {
      f.queue();
      worker.wake();
      await started.promise;
      const requested = f.store.cancel("owner", f.input.id);
      expect(requested.phase).toBe("running");
      expect(requested.steps[0]?.outcome).toBe("pending");
      expect(requested.cancellation?.actor).toBe("owner");
      expect(new WorkflowRepository(f.db, "x-post", f.now).leases.acquire()).toBeNull();
      response.resolve();
      await worker.idle();
      const result = f.store.get(f.input.id);
      expect(result.phase).toBe(outcome === "unknown" ? "needsAttention" : "cancelled");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.outcome).toBe(outcome === "unknown" ? "pending" : outcome);
      if (outcome === "succeeded") expect(result.steps[0]?.result).toEqual({ postId: "123", accountId: "456" });
      expect(calls).toEqual(["first"]);
      expect(errors).toEqual([]);
      expect(() => f.queue()).toThrow("cancelled");
      expect(f.store.cancel("owner", f.input.id)).toEqual(result);
    } finally {
      response.resolve();
      await worker.stop();
      f.dispose();
    }
  }
});

test("a final in-flight request can complete truthfully after a stop, with the stop audit preserved", async () => {
  const f = fixture();
  try {
    f.queue();
    await run(f.store, {
      authorize() {
        return () => {};
      },
      execute: (_owner, _plan, effects) =>
        effects.run("only", "post.create", {}, async () => {
          f.store.cancel("owner", f.input.id);
          return { postId: "123" };
        }),
    });
    const result = f.store.get(f.input.id);
    expect(result.phase).toBe("completed");
    expect(result.receipt).toEqual({ postId: "123" });
    expect(result.cancellation?.actor).toBe("owner");
    expect(f.store.cancel("owner", f.input.id)).toEqual(result);
  } finally {
    f.dispose();
  }
});

test("stopping media processing releases a waiting job and survives restart without another upload or lookup", async () => {
  const f = fixture();
  let uploads = 0;
  const handler = {
    authorize() {
      return () => {};
    },
    async execute(
      _owner: string,
      _plan: unknown,
      effects: import("../../src/server/delivery/workflows/ports.js").WorkflowEffects,
    ) {
      await effects.run("image", "media.upload", {}, async () => {
        uploads++;
        return { mediaId: "123" };
      });
      effects.observe("image.status", { mediaId: "123" }, { state: "pending" });
      return effects.wait(f.now() + 30000);
    },
  };
  try {
    f.queue();
    await run(f.store, handler);
    expect(f.store.get(f.input.id).phase).toBe("waiting");
    const result = f.store.cancel("owner", f.input.id);
    expect(result.phase).toBe("cancelled");
    expect(result.nextRunAt).toBeNull();
    expect(result.steps[0]?.result).toEqual({ mediaId: "123" });
    expect(result.observations).toHaveLength(1);
    f.advance();
    const reopened = new Database(join(f.root, "jobs.sqlite"));
    try {
      await run(new WorkflowRepository(reopened, "x-post", f.now), handler);
    } finally {
      reopened.close();
    }
    expect(uploads).toBe(1);
  } finally {
    f.dispose();
  }
});

test("a crash before a stopped request settles retains an unknown intent instead of authorizing another send", async () => {
  const f = fixture();
  let calls = 0;
  try {
    f.queue();
    const old = f.store.leases.acquire()!;
    const step = f.store.steps.intent(old, "first", "post.create", {}).step;
    f.store.cancel("owner", f.input.id);
    expect(() => f.store.steps.intent(old, "second", "post.create", {})).toThrow("cancelled");
    f.advance();
    await run(f.store, {
      authorize() {
        return () => {};
      },
      async execute() {
        calls++;
        return null;
      },
    });
    const result = f.store.get(f.input.id);
    expect(result.phase).toBe("needsAttention");
    expect(result.error).toBe("outcomeUnknown");
    expect(result.steps[0]?.outcome).toBe("pending");
    expect(calls).toBe(0);
    expect(() => f.store.steps.settle(old, step.id, "succeeded", {}, null)).toThrow("leaseLost");
  } finally {
    f.dispose();
  }
});

test("stop persistence failure leaves no misleading acknowledgement or partial state transition", () => {
  const f = fixture();
  try {
    f.queue();
    f.db.exec(
      "CREATE TRIGGER fail_stop BEFORE INSERT ON publication_cancellations BEGIN SELECT RAISE(ABORT,'disk unavailable'); END;",
    );
    expect(() => f.store.cancel("owner", f.input.id)).toThrow("disk unavailable");
    expect(f.store.get(f.input.id).phase).toBe("queued");
    expect(f.store.get(f.input.id).cancellation).toBeNull();
    expect(f.store.leases.acquire()?.id).toBe(f.input.id);
  } finally {
    f.dispose();
  }
});

test("schema five upgrades twice without altering existing plans, confirmations, steps or observations", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!;
    const step = f.store.steps.intent(lease, "image", "media.upload", {}).step;
    f.store.steps.settle(lease, step.id, "succeeded", { mediaId: "123" }, null);
    f.store.observations.record(lease, "image.status", { mediaId: "123" }, { state: "pending" });
    f.store.wait(lease, f.now() + 30000);
    const before = f.store.get(f.input.id);
    f.db.exec(
      "DROP INDEX publications_by_source; ALTER TABLE publication_plans DROP COLUMN sourceProjectId; DROP TABLE publication_successors; DROP TABLE publication_resolutions; DROP TABLE publication_recovery_evidence; DROP TABLE publication_cancellations; UPDATE publication_delivery_schema SET version=5;",
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

test("the X service stops a partial Thread while preserving an acknowledged post after account disconnection", async () => {
  const { socialFixture } = await import("../support/social-publication-fixture.js");
  const started = deferred(),
    response = deferred();
  const f = await socialFixture("A detailed reviewed paragraph about a careful publication. ".repeat(24), {
    async respond(path) {
      expect(path).toBe("/2/tweets");
      started.resolve();
      await response.promise;
      return { data: { id: "123", text: "Confirmed" } };
    },
  });
  try {
    const record = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(record);
    await started.promise;
    await expect(f.feature.service.cancel("other", "x-post", record.plan.id)).rejects.toThrow("notFound");
    const stopped = await f.feature.service.cancel("owner", "x-post", record.plan.id);
    expect(stopped.cancellation?.actor).toBe("owner");
    f.disable();
    response.resolve();
    await f.feature.idle();
    const result = await f.feature.service.detail("owner", "x-post", record.plan.id);
    expect(result.phase).toBe("cancelled");
    expect(result.steps[0]?.result).toMatchObject({ postId: "123", accountId: "123" });
    expect(result.steps).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    await f.restart();
    await f.feature.idle();
    expect(f.requests).toHaveLength(1);
    expect(await f.feature.service.detail("owner", "x-post", record.plan.id)).toEqual(result);
  } finally {
    response.resolve();
    await f.dispose();
  }
});
