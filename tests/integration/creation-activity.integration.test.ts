import { creationDocumentArtifact } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";

test("owner-wide creation history retains process and same-document revisions across restart", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async (input, callbacks, scope) => {
      await callbacks.message?.("The outline is ready; writing the detailed requirements.");
      await f.save(callbacks, scope, input.prompt.includes("Previous brief") ? "Updated result" : "Original result");
    });
    const first = await f.create("Write the product requirements with the selected skill.");
    const completed = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(
      (
        await f.files.call("/api/document-creations", "POST", {
          ...first.request,
          id: randomUUID(),
          creationKey: "t:" + completed.id,
        })
      ).status,
    ).toBe(400);
    const before = await f.files.call("/api/document-creations/detail?id=" + completed.id);
    expect(before.body.task.progress.map((event: any) => event.stage)).toContain("message");
    expect(before.body.task.progress.map((event: any) => event.stage)).toContain("preparing");
    expect(
      before.body.task.progress.some(
        (event: any) => event.stage === "activity" && event.operation === "panda_documents_create",
      ),
    ).toBe(true);
    expect(before.body.task.progress.map((event: any) => event.stage)).toContain("saving");
    const summary = await f.files.call("/api/document-creations/detail?id=" + completed.id + "&view=progress");
    expect(summary.status).toBe(200);
    expect(summary.body.task.progress.some((event: any) => event.stage === "message")).toBe(false);
    expect(summary.body.task.clarifications).toEqual([]);
    expect(summary.body.task.progress.some((event: any) => event.operation === "panda_documents_create")).toBe(true);
    expect(summary.body.task.artifact).toEqual(completed.artifact);
    expect((await f.files.call("/api/document-creations/detail?id=" + completed.id + "&view=unknown")).status).toBe(
      400,
    );
    await f.restart();
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks.map((task: any) => task.id)).toContain(
      completed.id,
    );
    expect((await f.files.call("/api/document-creations/detail?id=" + completed.id)).body.task.progress).toEqual(
      before.body.task.progress,
    );
    const request = {
      taskId: completed.id,
      id: randomUUID(),
      prompt: "Add acceptance criteria and permission boundaries.",
    };
    const result = await f.files.call("/api/document-creations/follow-up", "POST", request);
    expect(result.status).toBe(202);
    const revised = await f.until(request.id, (task) => task.state === "succeeded");
    expect((await f.files.call("/api/document-creations/follow-up", "POST", request)).body.task.id).toBe(request.id);
    expect(
      (await f.files.call("/api/document-creations/follow-up", "POST", { ...request, prompt: "Different request" }))
        .status,
    ).toBe(409);
    expect(creationDocumentArtifact(revised.artifact)!.documentId).toBe(
      creationDocumentArtifact(completed.artifact)!.documentId,
    );
    expect(f.scopes.at(-1)!.input.prompt).toContain("Original result");
    expect(f.scopes.at(-1)!.input.prompt).toContain(request.prompt);
    expect((await f.files.call("/api/document-creations/detail?id=" + revised.id)).body.task.previousTaskId).toBe(
      completed.id,
    );
    const grouped = await f.files.call("/api/document-creations?project=*");
    expect(grouped.body.tasks).toHaveLength(1);
    expect(grouped.body.tasks[0].creation).toMatchObject({ id: completed.id, prompt: first.request.prompt, rounds: 2 });
    const rounds = await f.files.call("/api/document-creations/rounds?id=" + completed.id);
    expect(rounds.body).toMatchObject({
      latestTaskId: revised.id,
      ids: [revised.id, completed.id],
      creation: { id: completed.id, rounds: 2 },
      nextCursor: null,
    });
    expect((await f.files.call("/api/document-creations/rounds?id=" + completed.id + "&cursor=invalid")).status).toBe(
      400,
    );
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
    f.actor("operator:another");
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks).toEqual([]);
    expect(
      (await f.files.call("/api/document-creations/follow-up", "POST", { ...request, id: randomUUID() })).status,
    ).toBe(404);
    expect((await f.files.call("/api/document-creations/detail?id=" + completed.id)).status).toBe(404);
    expect((await f.files.call("/api/document-creations/rounds?id=" + completed.id)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);

test("deadline failures keep the original brief discoverable and cannot be continued as a saved output", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async () => {
      throw Object.assign(new Error("Private provider context"), { code: "APPLICATION_ENGINE_DEADLINE" });
    });
    const first = await f.create("A long PRD that must remain visible if interrupted.");
    const failed = await f.until(first.request.id, (task) => task.state === "failed");
    expect(failed.failure).toBe("timedOut");
    const history = await f.files.call("/api/document-creations?project=*");
    expect(history.body.tasks[0].prompt).toBe(first.request.prompt);
    expect(JSON.stringify(history.body)).not.toContain("Private provider");
    expect(
      (
        await f.files.call("/api/document-creations/follow-up", "POST", {
          taskId: failed.id,
          id: randomUUID(),
          prompt: "Continue",
        })
      ).status,
    ).toBe(409);
    f.files.grants.delete("project-1");
    expect((await f.files.call("/api/document-creations?project=*")).body.tasks).toEqual([]);
    expect((await f.files.call("/api/document-creations/detail?id=" + failed.id)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);
