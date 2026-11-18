import { creationDocumentArtifact } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";

test("clearing one document hides all its writing rounds, retains documents and survives restart without hiding later work", async () => {
  const f = await creationAppFixture();
  try {
    const first = await f.create("Original"),
      original = await f.until(first.request.id, (task) => task.state === "succeeded");
    const follow = { id: randomUUID(), taskId: original.id, prompt: "Add acceptance criteria" };
    expect((await f.files.call("/api/document-creations/message", "POST", follow)).status).toBe(202);
    const revision = await f.until(follow.id, (task) => task.state === "succeeded"),
      documentId = creationDocumentArtifact(revision.artifact)!.documentId;
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks.map((task: any) => task.id)).toEqual([
      revision.id,
    ]);
    const request = { id: randomUUID(), taskId: revision.id },
      clear = () => f.files.call("/api/document-creations/history/clear", "POST", request);
    const result = await clear();
    expect(result).toMatchObject({ status: 200, body: { id: request.id, hidden: 2 } });
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks).toEqual([]);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
    expect((await f.task(original.id)).state).toBe("succeeded");
    await f.restart();
    expect(await clear()).toEqual(result);
    const next = { ...follow, id: randomUUID(), taskId: revision.id, prompt: "Another explicit update" };
    expect((await f.files.call("/api/document-creations/message", "POST", next)).status).toBe(202);
    await f.until(next.id, (task) => task.state === "succeeded");
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks.map((task: any) => task.id)).toEqual([
      next.id,
    ]);
    expect(await clear()).toEqual(result);
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks).toHaveLength(1);
    expect(
      (await f.files.call("/api/document-creations/history/clear", "POST", { ...request, taskId: original.id })).status,
    ).toBe(409);
    f.actor("operator:other");
    expect((await clear()).status).toBe(404);
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks).toEqual([]);
    expect((await f.files.application().queries.detail("project-1", documentId)).document.id).toBe(documentId);
  } finally {
    await f.close();
  }
}, 60000);

test("clear all freezes its receipt, does not stop active writing and leaves new tasks visible", async () => {
  const f = await creationAppFixture(),
    ready = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  try {
    f.onRun(async (_input, callbacks, scope) => {
      ready.resolve();
      await proceed.promise;
      await f.save(callbacks, scope);
    });
    const first = await f.create("Running document");
    await ready.promise;
    const request = { id: randomUUID() },
      clear = () => f.files.call("/api/document-creations/history/clear", "POST", request);
    const result = await clear();
    expect(result).toMatchObject({ status: 200, body: { hidden: 1 } });
    expect((await f.task(first.request.id)).cancelRequested).toBe(false);
    proceed.resolve();
    const completed = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(completed.artifact).toBeTruthy();
    const second = await f.create("New work after clearing");
    await f.until(second.request.id, (task) => task.state === "succeeded");
    expect(await clear()).toEqual(result);
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks.map((task: any) => task.id)).toEqual([
      second.request.id,
    ]);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(2);
    expect(
      (
        await f.files.call(
          "/api/document-creations/history/clear",
          "POST",
          { id: randomUUID() },
          { origin: "https://foreign.invalid" },
        )
      ).status,
    ).toBe(403);
  } finally {
    proceed.resolve();
    await f.close();
  }
}, 60000);
