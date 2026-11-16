import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { workflowFixture, runWorkflow } from "../support/workflow-fixture.js";
import { digest } from "../../src/server/delivery/digest.js";

test("workflow source scope is fingerprinted, indexed and replayed without altering an old plan", () => {
  const f = workflowFixture();
  try {
    const old = f.db.query("SELECT record,request FROM publication_plans WHERE id=?").get(f.input.id);
    const input = { ...f.input, id: randomUUID(), sourceProjectId: f.input.projectId },
      native = f.store.prepare("owner", digest("file source"), input);
    expect(native.plan.sourceProjectId).toBe(f.input.projectId);
    expect(f.store.list("owner", f.input.spaceId).map((row) => row.plan.id)).toEqual([f.input.id]);
    expect(f.store.list("owner", f.input.spaceId, f.input.projectId).map((row) => row.plan.id)).toEqual([
      native.plan.id,
    ]);
    expect(f.store.prepare("owner", digest("file source"), { ...input, id: randomUUID() })).toEqual(native);
    expect(f.db.query("SELECT record,request FROM publication_plans WHERE id=?").get(f.input.id)).toEqual(old);
    f.db.query("UPDATE publication_plans SET sourceProjectId=? WHERE id=?").run(randomUUID(), native.plan.id);
    expect(() => f.store.get(native.plan.id)).toThrow("invalidSnapshot");
    expect(() => f.store.list("owner", f.input.spaceId)).not.toThrow();
  } finally {
    f.dispose();
  }
});
test("workflow asynchronous authorization stays outside lease transactions and each new effect uses its synchronous guard", async () => {
  const f = workflowFixture();
  let readsInTransaction = false,
    guards = 0,
    remote = 0;
  try {
    f.queue();
    expect(
      await runWorkflow(f.store, {
        async authorize() {
          readsInTransaction ||= f.db.inTransaction;
          await Promise.resolve();
          return () => {
            guards++;
          };
        },
        async execute(_owner, _plan, effects) {
          effects.inspect();
          await effects.run("first", "post.create", { text: "first" }, async () => {
            remote++;
            return { id: "123" };
          });
          return effects.run("second", "post.create", { text: "second" }, async () => {
            remote++;
            return { id: "124" };
          });
        },
      }),
    ).toEqual([]);
    expect(readsInTransaction).toBe(false);
    expect(guards).toBeGreaterThanOrEqual(3);
    expect(remote).toBe(2);
    expect(f.store.get(f.input.id).phase).toBe("completed");
  } finally {
    f.dispose();
  }
});
