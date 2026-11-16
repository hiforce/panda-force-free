import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import { DeliveryError } from "../../src/server/delivery/errors.js";
import { digest } from "../../src/server/delivery/digest.js";
import type { WorkflowHandler } from "../../src/server/delivery/workflows/ports.js";
import { initializePublicationSchema } from "../../src/server/delivery/storage/schema.js";

import { workflowFixture as fixture, runWorkflow as run } from "../support/workflow-fixture.js";

test("replacement receipts require explicit resume and cannot erase pending, successful or unrelated operations", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!;
    const before = f.store.steps.intent(lease, "image.old", "media.metadata", {}).step;
    f.store.steps.settle(lease, before.id, "rejected", null, "platformRejected");
    const after = f.store.steps.intent(lease, "image.new", "media.metadata", { changed: true }).step;
    f.store.steps.settle(lease, after.id, "succeeded", { id: "123" }, null);
    expect(() => f.store.steps.replaceRejected(lease, "image.old", "image.new")).toThrow(
      "publicationConfirmationRequired",
    );
    f.store.finish(lease, "failed", null, "platformRejected");
    f.store.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true);
    const resume = f.store.leases.acquire()!;
    const pending = f.store.steps.intent(resume, "image.pending", "media.metadata", {}).step;
    expect(() => f.store.steps.replaceRejected(resume, "image.pending", "image.new")).toThrow("invalidReceipt");
    expect(() => f.store.steps.replaceRejected(resume, "image.new", "image.old")).toThrow("invalidReceipt");
    f.store.steps.settle(resume, pending.id, "rejected", null, "platformRejected");
    const different = f.store.steps.intent(resume, "post.new", "post.create", {}).step;
    f.store.steps.settle(resume, different.id, "succeeded", { id: "456" }, null);
    expect(() => f.store.steps.replaceRejected(resume, "image.old", "post.new")).toThrow("invalidReceipt");
    const last = f.store.steps.intent(resume, "image.last", "media.metadata", {}).step;
    f.store.steps.settle(resume, last.id, "succeeded", { id: "789" }, null);
    f.store.steps.replaceRejected(resume, "image.old", "image.new");
    f.store.steps.replaceRejected(resume, "image.pending", "image.last");
    expect(f.store.steps.intent(resume, "image.old", "media.metadata", {}).send).toBe(false);
    expect(f.store.finish(resume, "completed", {}, null).steps[0]).toMatchObject({
      outcome: "rejected",
      error: "platformRejected",
      replacedBy: after.id,
    });
  } finally {
    f.dispose();
  }
});

test("schema four upgrades preserve frozen plans, confirmations, receipts and retry state", () => {
  const f = fixture();
  try {
    f.queue();
    const lease = f.store.leases.acquire()!;
    const step = f.store.steps.intent(lease, "post.1", "post.create", { text: "Frozen" }).step;
    f.store.steps.settle(lease, step.id, "succeeded", { postId: "123" }, null);
    f.store.finish(lease, "completed", { postId: "123" }, null);
    const before = f.store.get(f.input.id);
    f.db.exec(
      "DROP INDEX publications_by_source; ALTER TABLE publication_plans DROP COLUMN sourceProjectId; DROP TABLE publication_successors; DROP TABLE publication_resolutions; DROP TABLE publication_recovery_evidence; DROP TABLE publication_cancellations; DROP TABLE publication_observations; ALTER TABLE publication_jobs DROP COLUMN nextRunAt; ALTER TABLE publication_steps DROP COLUMN replacedBy; UPDATE publication_delivery_schema SET version=4;",
    );
    initializePublicationSchema(f.db);
    initializePublicationSchema(f.db);
    expect(f.store.get(f.input.id)).toEqual(before);
    expect(f.db.query<{ version: number }, []>("SELECT version FROM publication_delivery_schema").get()?.version).toBe(
      9,
    );
  } finally {
    f.dispose();
  }
});

test("workflow identities prevent duplicate plans across requests and isolate site jobs and owners", () => {
  const f = fixture();
  try {
    expect(f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID() })).toEqual(f.record);
    expect(() =>
      f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID(), payload: { posts: ["changed"] } }),
    ).toThrow("conflict");
    expect(() => f.store.owned("someone", f.input.id)).toThrow("notFound");
    expect(() => f.store.queue("owner", f.input.id, "stale", () => {})).toThrow("conflict");
    f.queue();
    const sites = new PublicationRepository(f.db, f.now);
    expect(sites.list("owner", f.input.spaceId)).toEqual([]);
    expect(sites.acquire()).toBeNull();
    sites.expire();
    expect(() => sites.get(f.input.id)).toThrow("notFound");
    const articles = new WorkflowRepository(f.db, "x-article", f.now);
    expect(articles.leases.acquire()).toBeNull();
    expect(f.store.leases.acquire()?.id).toBe(f.input.id);
  } finally {
    f.dispose();
  }
});

test("partial threads resume only after explicit authorization and never resend acknowledged parts", async () => {
  const f = fixture();
  const calls: string[] = [];
  let reject = true;
  const handler: WorkflowHandler = {
    authorize: () => () => {},
    execute: async (_owner, _plan, effects) => {
      const receipts = [];
      for (const name of ["first", "second", "third"]) {
        receipts.push(
          await effects.run(name, "post.create", { text: name }, async () => {
            calls.push(name);
            if (name === "second" && reject) throw new RemoteOperationError("rateLimited", "rejected");
            return { id: name };
          }),
        );
      }
      return receipts;
    },
  };
  try {
    f.queue();
    expect(await run(f.store, handler)).toEqual([]);
    expect(f.store.get(f.input.id).phase).toBe("failed");
    expect(calls).toEqual(["first", "second"]);
    expect(() => f.queue()).toThrow("conflict");
    reject = false;
    await run(f.store, handler);
    expect(calls).toHaveLength(2);
    const reopened = new Database(join(f.root, "jobs.sqlite"));
    try {
      const recovered = new WorkflowRepository(reopened, "x-post", f.now);
      recovered.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true);
      await run(recovered, handler);
      expect(calls).toEqual(["first", "second", "second", "third"]);
      const result = recovered.get(f.input.id);
      expect(result.phase).toBe("completed");
      expect(result.receipt).toEqual([{ id: "first" }, { id: "second" }, { id: "third" }]);
      expect(result.steps.map((step) => step.outcome)).toEqual(["succeeded", "rejected", "succeeded", "succeeded"]);
      recovered.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true);
      await run(recovered, handler);
      expect(calls).toHaveLength(4);
    } finally {
      reopened.close();
    }
  } finally {
    f.dispose();
  }
});

test("a crash after dispatch is an unknown outcome and never grants another send", async () => {
  const f = fixture();
  let calls = 0;
  try {
    f.queue();
    const stale = f.store.leases.acquire()!;
    f.store.steps.intent(stale, "first", "post.create", { text: "first" });
    f.advance();
    const recovered = new WorkflowRepository(f.db, "x-post", f.now);
    const handler: WorkflowHandler = {
      authorize: () => () => {},
      execute: (_owner, _plan, effects) =>
        effects.run("first", "post.create", { text: "first" }, async () => {
          calls++;
          return { id: "123" };
        }),
    };
    expect(await run(recovered, handler)).toEqual([]);
    expect(calls).toBe(0);
    expect(recovered.get(f.input.id).phase).toBe("needsAttention");
    expect(() => recovered.queue("owner", f.input.id, f.record.plan.fingerprint, () => {}, true)).toThrow("conflict");
    expect(() => f.store.steps.settle(stale, 1, "succeeded", { id: "123" }, null)).toThrow("leaseLost");
    await run(recovered, handler);
    expect(calls).toBe(0);
  } finally {
    f.dispose();
  }
});

test("a committed receipt survives a crash before completion without repeating its operation", async () => {
  const f = fixture();
  try {
    f.queue();
    const old = f.store.leases.acquire()!;
    const operation = f.store.steps.intent(old, "first", "post.create", { text: "first" });
    f.store.steps.settle(old, operation.step.id, "succeeded", { id: "123" }, null);
    f.advance();
    let calls = 0;
    await run(f.store, {
      authorize: () => () => {},
      execute: (_owner, _plan, effects) =>
        effects.run("first", "post.create", { text: "first" }, async () => {
          calls++;
          return null;
        }),
    });
    expect(calls).toBe(0);
    expect(f.store.get(f.input.id).receipt).toEqual({ id: "123" });
    expect(f.store.get(f.input.id).phase).toBe("completed");
  } finally {
    f.dispose();
  }
});

test("transport failure and receipt persistence failure remain unresolved, with no raw exception data", async () => {
  for (const failWrite of [false, true]) {
    const f = fixture();
    try {
      f.queue();
      if (failWrite)
        f.db.exec(
          "CREATE TRIGGER fail_receipt BEFORE UPDATE OF outcome ON publication_steps BEGIN SELECT RAISE(ABORT,'secret failure'); END;",
        );
      await run(f.store, {
        authorize: () => () => {},
        execute: (_owner, _plan, effects) =>
          effects.run("first", "post.create", { text: "first" }, async () => {
            if (!failWrite) throw new Error("raw secret failure");
            return { id: "123" };
          }),
      });
      const record = f.store.get(f.input.id);
      expect(record.phase).toBe("needsAttention");
      expect(record.error).toBe("deliveryFailed");
      expect(record.steps[0]?.outcome).toBe("pending");
      expect(JSON.stringify(record)).not.toContain("secret");
    } finally {
      f.dispose();
    }
  }
});

test("ownership or configuration changes stop subsequent remote operations even in a partial job", async () => {
  const f = fixture();
  let enabled = true,
    calls = 0;
  try {
    f.queue();
    await run(f.store, {
      authorize: () => {
        const guard = () => {
          if (!enabled) throw new DeliveryError("connectionDisabled");
        };
        guard();
        return guard;
      },
      execute: async (_owner, _plan, effects) => {
        await effects.run("first", "post.create", {}, async () => {
          calls++;
          enabled = false;
          return { id: "123" };
        });
        return effects.run("second", "post.create", {}, async () => {
          calls++;
          return null;
        });
      },
    });
    expect(calls).toBe(1);
    expect(f.store.get(f.input.id).phase).toBe("failed");
    expect(f.store.get(f.input.id).steps).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test("a second worker cannot acquire a live lease, and pending steps cannot be hidden by a handler", async () => {
  const f = fixture();
  try {
    f.queue();
    await run(f.store, {
      authorize: () => () => {},
      execute: async (_owner, _plan, effects) => {
        expect(new WorkflowRepository(f.db, "x-post", f.now).leases.acquire()).toBeNull();
        try {
          await effects.run("first", "post.create", {}, async () => {
            throw new Error("lost response");
          });
        } catch {
          /* Simulate a faulty handler. */
        }
        return { success: true };
      },
    });
    expect(f.store.get(f.input.id).phase).toBe("needsAttention");
    expect(f.store.get(f.input.id).receipt).toBeNull();
  } finally {
    f.dispose();
  }
});

test("JSON snapshots reject lossy values and completed step keys cannot be repurposed", () => {
  const f = fixture();
  try {
    expect(() =>
      f.store.prepare("owner", digest("new"), { ...f.input, id: randomUUID(), payload: { nan: NaN } }),
    ).toThrow("invalidInput");
    f.queue();
    const lease = f.store.leases.acquire()!;
    const item = f.store.steps.intent(lease, "first", "post.create", { text: "first" });
    f.store.steps.settle(lease, item.step.id, "succeeded", { id: "123" }, null);
    expect(() => f.store.steps.intent(lease, "first", "post.create", { text: "changed" })).toThrow("conflict");
    expect(f.store.steps.intent(lease, "first", "post.create", { text: "first" }).send).toBe(false);
  } finally {
    f.dispose();
  }
});

test("cancellation requires an explicit successor and retains the original semantic history", () => {
  const f = fixture();
  try {
    f.store.cancel("owner", f.input.id);
    const stopped = f.store.get(f.input.id);
    expect(f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID() }).plan.id).toBe(f.input.id);
    expect(() =>
      f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID(), payload: { posts: ["changed"] } }),
    ).toThrow("conflict");
    const next = f.store.lineage.create(
      "owner",
      f.input.id,
      stopped.continuationToken,
      { ...f.input, id: randomUUID() },
      () => {},
    );
    expect(next.plan.id).not.toBe(f.input.id);
    expect(next.phase).toBe("prepared");
    expect(f.store.get(f.input.id).phase).toBe("cancelled");
    expect(f.store.get(f.input.id).plan.payload).toEqual(f.input.payload);
    f.store.queue("owner", next.plan.id, next.plan.fingerprint, () => {});
    const lease = f.store.leases.acquire()!;
    const step = f.store.steps.intent(lease, "post.1", "post.create", {});
    f.store.steps.settle(lease, step.step.id, "rejected", null, "platformRejected");
    f.store.finish(lease, "failed", null, "platformRejected");
    const cancelled = f.store.cancel("owner", next.plan.id);
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.steps[0]?.outcome).toBe("rejected");
    expect(() => f.store.queue("owner", next.plan.id, next.plan.fingerprint, () => {}, true)).toThrow("cancelled");
    expect(
      f.store.prepare("owner", digest("identity"), { ...f.input, id: randomUUID(), payload: next.plan.payload }).plan
        .id,
    ).toBe(next.plan.id);
  } finally {
    f.dispose();
  }
});

test("waiting workflows survive restart, release their lease and reuse acknowledged effects after the due time", async () => {
  const f = fixture();
  let sends = 0,
    checks = 0;
  const handler: WorkflowHandler = {
    authorize() {
      return () => {};
    },
    async execute(_owner, _plan, effects) {
      const uploaded = await effects.run("asset.1", "media.upload", { digest: "fixture" }, async () => {
        sends++;
        return { mediaId: "501" };
      });
      const state = effects.inspect();
      expect(state.confirmation).toBe(1);
      checks++;
      if (!state.observations.length) {
        effects.observe("asset.1", { mediaId: "501" }, { state: "pending" });
        effects.wait(f.now() + 30000);
      }
      expect(state.observations[0]!.result).toEqual({ state: "pending" });
      effects.observe("asset.1", { mediaId: "501" }, { state: "succeeded" });
      return uploaded;
    },
  };
  try {
    f.queue();
    await run(f.store, handler);
    expect(f.store.get(f.input.id).phase).toBe("waiting");
    expect(f.store.get(f.input.id).nextRunAt).toBe(f.now() + 30000);
    expect(f.store.leases.acquire()).toBeNull();
    expect(f.queue().confirmations).toHaveLength(1);
    const restarted = new WorkflowRepository(f.db, "x-post", f.now);
    await run(restarted, handler);
    expect(checks).toBe(1);
    f.advance();
    await run(restarted, handler);
    const done = restarted.get(f.input.id);
    expect(done.phase).toBe("completed");
    expect(done.nextRunAt).toBeNull();
    expect(done.observations[0]!.result).toEqual({ state: "succeeded" });
    expect(sends).toBe(1);
    expect(checks).toBe(2);
  } finally {
    f.dispose();
  }
});

test("deferred polling cannot conceal an unknown mutation or bypass lease and observation identity guards", async () => {
  const f = fixture();
  try {
    f.queue();
    await run(f.store, {
      authorize() {
        return () => {};
      },
      async execute(_owner, _plan, effects) {
        try {
          await effects.run("upload", "media.upload", {}, async () => {
            throw Error("lost reply");
          });
        } catch {
          effects.wait(f.now() + 30000);
        }
        return null;
      },
    });
    expect(f.store.get(f.input.id).phase).toBe("needsAttention");
    f.advance();
    expect(f.store.leases.acquire()).toBeNull();
    const other = f.store.prepare("owner", digest("other"), { ...f.input, id: randomUUID() });
    f.store.queue("owner", other.plan.id, other.plan.fingerprint, () => {});
    const lease = f.store.leases.acquire()!;
    f.store.observations.record(lease, "media.status", { id: "501" }, { state: "pending" });
    expect(() => f.store.observations.record(lease, "media.status", { id: "502" }, {})).toThrow("conflict");
    f.advance();
    const newer = f.store.leases.acquire()!;
    expect(() => f.store.observations.record(lease, "media.status", { id: "501" }, {})).toThrow("leaseLost");
    expect(() => f.store.wait(lease, f.now() + 1000)).toThrow("leaseLost");
    expect(() => f.store.wait(newer, f.now() + 3600001)).toThrow("invalidInput");
    expect(f.store.get(other.plan.id).observations[0]!.result).toEqual({ state: "pending" });
  } finally {
    f.dispose();
  }
});
