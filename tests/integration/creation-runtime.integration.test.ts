import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";

test("real HTTP creation, durable questions and saving use scoped engine callbacks; a waiting task releases inference capacity", async () => {
  const f = await creationAppFixture();
  let secondStarted = false,
    answered = "";
  try {
    f.onRun(async (input, callbacks, scope) => {
      if (input.prompt.startsWith("First")) {
        const result = await callbacks.question!(scope, [
          { id: "audience", question: "Who is this for?", options: [{ label: "Developers" }] },
        ]);
        answered = result.audience!.answers[0]!;
        await f.save(callbacks, scope, answered);
      } else {
        secondStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(callbacks.signal.reason);
          callbacks.signal.addEventListener("abort", abort, { once: true });
          if (callbacks.signal.aborted) abort();
        });
      }
    });
    const first = await f.create("First: write for the chosen audience.");
    expect(first.response.status).toBe(202);
    const pending = await f.until(first.request.id, (task) => !!task.question);
    const second = await f.create("Second: remain active until cancelled.");
    expect(second.response.status).toBe(202);
    await f.until(second.request.id, (task) => task.state === "running" && secondStarted);
    expect(secondStarted).toBe(true);
    const response = await f.files.call("/api/document-creations/answer", "POST", {
      id: pending.question!.id,
      answers: { audience: { answers: ["Developers"] } },
    });
    expect(response.status).toBe(200);
    await f.files.call("/api/document-creations/cancel", "POST", { id: second.request.id });
    const completed = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(answered).toBe("Developers");
    expect(completed.artifact!.projectId).toBe("project-1");
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
    const encoded = JSON.stringify(completed);
    for (const field of ["inputDigest", "operation identity", "token", "leaseUntil", "sessionId", "instructions"])
      expect(encoded).not.toContain(field);
    const cancelled = await f.task(second.request.id);
    expect(cancelled.state).toBe("cancelled");
    await expect(f.save(f.scopes[1]!.callbacks, f.scopes[1]!.scope, "late result")).rejects.toThrow();
    f.actor("operator:other");
    expect((await f.files.call("/api/document-creations/detail?id=" + first.request.id)).status).toBe(404);
    expect((await f.files.call("/api/document-creations?project=project-1")).body.tasks).toEqual([]);
  } finally {
    await f.close();
  }
}, 60000);

test("a question survives application restart and resumes the same task with its captured model and answered history", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async (input, callbacks, scope) => {
      if (!input.prompt.includes("Previously answered task questions"))
        await callbacks.question!(scope, [{ id: "tone", question: "Which tone?", options: [{ label: "Clear" }] }]);
      else {
        expect(input.prompt).toContain('"Clear"');
        await f.save(callbacks, scope);
      }
    });
    const first = await f.create("Create a document with a chosen tone.");
    const pending = await f.until(first.request.id, (task) => !!task.question);
    f.changeProfile("changed-model");
    await f.restart();
    expect((await f.task(first.request.id)).question!.id).toBe(pending.question!.id);
    const answer = await f.files.call("/api/document-creations/answer", "POST", {
      id: pending.question!.id,
      answers: { tone: { answers: ["Clear"] } },
    });
    expect(answer.status).toBe(200);
    const completed = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(completed.generation).toBe(2);
    expect(f.scopes.map((value) => value.profileModel)).toEqual(["original-model", "original-model"]);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60000);

test("an unsaved text-only run fails explicitly; stable retry and origin checks cannot launch duplicates or grant extra tools", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async () => {});
    const submitted = await f.create("Create a saved file, not a text claim.");
    expect((await f.until(submitted.request.id, (task) => task.state === "failed")).failure).toBe("invalidOutput");
    const foreign = await f.files.call(
      "/api/document-creations/retry",
      "POST",
      { id: submitted.request.id, operationId: randomUUID() },
      { origin: "https://other.invalid" },
    );
    expect(foreign.status).toBe(403);
    expect(f.runs()).toBe(1);
    f.onRun(async (_input, callbacks, scope) => {
      await f.save(callbacks, scope);
    });
    const input = { id: submitted.request.id, operationId: randomUUID() };
    expect((await f.files.call("/api/document-creations/retry", "POST", input)).status).toBe(200);
    expect((await f.files.call("/api/document-creations/retry", "POST", input)).status).toBe(200);
    await f.until(submitted.request.id, (task) => task.state === "succeeded");
    expect(f.runs()).toBe(2);
    const old = (await f.files.call("/api/skill-packs?limit=100")).body.packages.find(
      (pack: { id: string }) => pack.id === "panda-force.writing",
    );
    const rejected = await f.files.call("/api/document-creations", "POST", {
      ...submitted.request,
      id: randomUUID(),
      selections: [{ packageId: old.id, version: old.version, digest: old.digest, id: "writing", parameters: {} }],
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.messageId).toBe("creation.unsupportedSkill");
    expect(f.runs()).toBe(2);
  } finally {
    await f.close();
  }
}, 60000);

test("a creation can clarify, answer a follow-up without saving, then revise the original using the discussion", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async (input, callbacks, scope) => {
      const turn = (action: string, text?: string) =>
        callbacks.call({
          ...scope,
          callId: randomUUID(),
          name: "panda_creation_turn",
          arguments: { action, ...(text === undefined ? {} : { text }) },
        });
      expect(input.tools.some((tool) => tool.name === "panda_creation_turn")).toBe(true);
      if (input.prompt.startsWith("Why")) {
        const blocked = await f.save(callbacks, scope, "This write must be blocked.");
        expect(blocked.success).toBe(false);
        expect(JSON.parse(blocked.text)).toMatchObject({ error: "deliveryRequired" });
        await turn("reply", "The first draft used the classification from its brief.");
      } else {
        if (input.prompt.startsWith("Prepare")) {
          const answer = await turn("clarify", "Who will read it?");
          const clarified = JSON.parse(answer.text);
          expect(Object.values(clarified.answers)).toEqual([{ answers: ["Students"] }]);
          expect(clarified.next).toContain('{"action":"deliver"}');
          const blocked = await f.save(callbacks, scope, "Must not be saved before delivery is selected.");
          expect(blocked.success).toBe(false);
          expect(JSON.parse(blocked.text)).toMatchObject({ error: "deliveryRequired", retryable: true });
          expect(JSON.parse(blocked.text).action).toContain('{"action":"deliver"}');
          expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
        } else {
          expect(input.prompt).toContain("The first draft used the classification from its brief.");
        }
        expect((await turn("deliver", "")).success).toBe(true);
        expect(
          (
            await callbacks.call({
              ...scope,
              callId: randomUUID(),
              name: "panda_creation_context",
              arguments: {},
            })
          ).success,
        ).toBe(true);
        expect(
          (await f.save(callbacks, scope, input.prompt.startsWith("Prepare") ? "Original" : "Revised")).success,
        ).toBe(true);
      }
    });
    const { body } = await f.files.call("/api/document-creations/options");
    const first = randomUUID();
    const start = await f.files.call("/api/document-creations", "POST", {
      id: first,
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      locale: "en",
      prompt: "Prepare a classification guide.",
      profileId: "codex",
      selections: [body.defaultWorkflow],
      dialogue: true,
      outputType: "auto",
    });
    expect(start.status).toBe(202);
    const pending = await f.until(first, (task) => !!task.question);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
    expect(
      (
        await f.files.call("/api/document-creations/answer", "POST", {
          id: pending.question!.id,
          answers: { [pending.question!.questions[0]!.id]: { answers: ["Students"] } },
        })
      ).status,
    ).toBe(200);
    const original = await f.until(first, (task) => task.state === "succeeded");
    const second = randomUUID();
    const request = { taskId: first, id: second, prompt: "Why is it classified that way?", dialogue: true };
    expect((await f.files.call("/api/document-creations/message", "POST", request)).status).toBe(202);
    const reply = await f.until(second, (task) => task.state === "replied");
    expect(reply.artifact).toBeNull();
    expect(reply.progress.find((event) => event.stage === "reply")?.text).toContain("first draft");
    await f.restart();
    expect((await f.files.call("/api/document-creations/message", "POST", request)).status).toBe(202);
    expect((await f.task(first)).artifact).toEqual(original.artifact);
    const third = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/message", "POST", {
          taskId: second,
          id: third,
          prompt: "Revise the original using the corrected classification.",
          dialogue: true,
        })
      ).status,
    ).toBe(202);
    const revised = await f.until(third, (task) => task.state === "succeeded");
    expect(revised.artifact).toMatchObject({ documentId: (original.artifact as { documentId: string }).documentId });
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
    expect(f.runs()).toBe(3);
  } finally {
    await f.close();
  }
}, 150000);
