import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreationTaskDetail } from "../../src/shared/creation/contracts.js";
import { creationAppFixture } from "../support/creation-app.js";
const goal = async (
  f: Awaited<ReturnType<typeof creationAppFixture>>,
  taskId: string,
  action: string,
  objective?: string,
  id = randomUUID(),
) =>
  f.files.call("/api/document-creations/goal", "POST", {
    taskId,
    id,
    action,
    ...(objective === undefined ? {} : { objective }),
  });
const context = async (scope: Awaited<ReturnType<typeof creationAppFixture>>["scopes"][number]) =>
  scope.callbacks.call({ ...scope.scope, name: "panda_creation_context", callId: randomUUID(), arguments: {} });

test("goal updates and removal fence saving until the writer reads the current objective", async () => {
  const f = await creationAppFixture(),
    ready = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  try {
    f.onRun(async () => {
      ready.resolve();
      await finish.promise;
    });
    const created = await f.create("Write a product requirements document"),
      taskId = created.response.body.task.id;
    await ready.promise;
    const first = await goal(
      f,
      taskId,
      "create",
      "Cover the category tree and inherited fields.\nInclude acceptance examples.",
    );
    expect(first.status).toBe(200);
    expect(first.body.goal.status).toBe("active");
    const scope = f.scopes[0]!;
    expect((await f.save(scope.callbacks, scope.scope)).text).toContain("contextChanged");
    const current = JSON.parse((await context(scope)).text);
    expect(current.goal.objective).toContain("inherited fields");
    expect((await goal(f, taskId, "set", "Also include per-channel field mappings")).status).toBe(200);
    expect((await f.save(scope.callbacks, scope.scope)).text).toContain("contextChanged");
    await context(scope);
    const cleared = await goal(f, taskId, "clear");
    expect(cleared.status).toBe(200);
    expect(cleared.body.goal).toBeNull();
    expect((await f.save(scope.callbacks, scope.scope)).text).toContain("contextChanged");
    expect(JSON.parse((await context(scope)).text).goal).toBeNull();
    expect((await f.save(scope.callbacks, scope.scope)).success).toBe(true);
    finish.resolve();
    expect((await f.until(taskId, (task) => task.state === "succeeded")).artifact).not.toBeNull();
  } finally {
    finish.resolve();
    await f.close();
  }
}, 30000);

test("a paused goal survives restart, resumes one execution, and rejects stale saves and repeated command changes", async () => {
  const f = await creationAppFixture(),
    started = Promise.withResolvers<void>();
  try {
    f.onRun(async (_input, callbacks) => {
      started.resolve();
      await new Promise<void>((_, reject) =>
        callbacks.signal.addEventListener("abort", () => reject(callbacks.signal.reason), { once: true }),
      );
    });
    const created = await f.create("Draft a release plan"),
      taskId = created.response.body.task.id;
    await started.promise;
    const id = randomUUID();
    const first = await goal(f, taskId, "create", "Create an actionable release plan", id);
    expect(first.status).toBe(200);
    expect((await goal(f, taskId, "create", "Create an actionable release plan", id)).body.goal.id).toBe(
      first.body.goal.id,
    );
    expect((await goal(f, taskId, "create", "Different target", id)).status).toBe(409);
    const old = f.scopes[0]!;
    const pauseId = randomUUID();
    const pause = await goal(f, taskId, "pause", undefined, pauseId);
    expect(pause.status).toBe(200);
    expect(pause.body.goal.status).toBe("paused");
    await expect(f.save(old.callbacks, old.scope)).rejects.toThrow(/cancelled|leaseLost/);
    await f.restart();
    const detail = await f.files.call("/api/document-creations/detail?id=" + taskId);
    expect((detail.body.task as CreationTaskDetail).goal?.status).toBe("paused");
    const before = f.runs();
    await Bun.sleep(80);
    expect(f.runs()).toBe(before);
    f.onRun(async (_input, callbacks, scope) => {
      await callbacks.call({ ...scope, name: "panda_creation_context", callId: randomUUID(), arguments: {} });
      expect((await f.save(callbacks, scope)).success).toBe(true);
    });
    const resumeId = randomUUID();
    expect((await goal(f, taskId, "resume", undefined, resumeId)).status).toBe(200);
    expect((await goal(f, taskId, "resume", undefined, resumeId)).status).toBe(200);
    const done = await f.until(taskId, (task) => task.state === "succeeded");
    expect(done.artifact).not.toBeNull();
    expect(f.runs()).toBe(before + 1);
    const final = await f.files.call("/api/document-creations/detail?id=" + taskId);
    expect(final.body.task.goal.status).toBe("completed");
    const bytes = JSON.stringify(final.body);
    expect(bytes).not.toContain('"token":');
    expect(bytes).not.toContain('"sessionId":');
    const beforeConflict = await f.files.call("/api/document-creations?project=project-1");
    expect((await goal(f, taskId, "set", "A reused operation must not create a revision", pauseId)).status).toBe(409);
    expect((await f.files.call("/api/document-creations?project=project-1")).body.tasks.length).toBe(
      beforeConflict.body.tasks.length,
    );
    f.actor("operator:someone-else");
    expect((await goal(f, taskId, "clear")).status).toBe(404);
  } finally {
    await f.close();
  }
}, 30000);

test("editing a finished goal creates one writing round that updates the same document", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async (_input, callbacks, scope) => {
      await callbacks.call({ ...scope, name: "panda_creation_context", callId: randomUUID(), arguments: {} });
      expect((await f.save(callbacks, scope)).success).toBe(true);
    });
    const created = await f.create("Write the first version"),
      taskId = created.response.body.task.id;
    const original = await f.until(taskId, (task) => task.state === "succeeded");
    const id = randomUUID(),
      first = await goal(f, taskId, "set", "Add concrete acceptance criteria", id);
    expect(first.status).toBe(200);
    expect(first.body.task.id).not.toBe(taskId);
    const replay = await goal(f, taskId, "set", "Add concrete acceptance criteria", id);
    expect(replay.status).toBe(200);
    expect(replay.body.task.id).toBe(first.body.task.id);
    const done = await f.until(first.body.task.id, (task) => task.state === "succeeded");
    expect(done.artifact?.documentId).toBe(original.artifact?.documentId);
    expect((await f.task(taskId)).artifact).toEqual(original.artifact);
  } finally {
    await f.close();
  }
}, 30000);

test("the scoped goal tool creates only one goal and cannot replace a later user objective", async () => {
  const f = await creationAppFixture(),
    ready = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  try {
    f.onRun(async () => {
      ready.resolve();
      await finish.promise;
    });
    const created = await f.create("Use a goal to prepare this document"),
      id = created.response.body.task.id;
    await ready.promise;
    const run = f.scopes[0]!,
      call = {
        ...run.scope,
        callId: randomUUID(),
        name: "panda_creation_goal",
        arguments: { action: "create", objective: "Prepare a practical first draft" },
      };
    const first = await run.callbacks.call(call);
    expect(first.success).toBe(true);
    expect((await run.callbacks.call(call)).text).toBe(first.text);
    expect((await goal(f, id, "set", "The user changed the target to include acceptance criteria")).status).toBe(200);
    const conflict = await run.callbacks.call({ ...call, callId: randomUUID() });
    expect(conflict.success).toBe(false);
    expect(conflict.text).toContain("goalAlreadyExists");
    const latest = JSON.parse((await context(run)).text);
    expect(latest.goal.objective).toContain("acceptance criteria");
    expect((await f.save(run.callbacks, run.scope)).success).toBe(true);
    finish.resolve();
    expect((await f.until(id, (task) => task.state === "succeeded")).goal?.status).toBe("completed");
  } finally {
    finish.resolve();
    await f.close();
  }
}, 30000);
