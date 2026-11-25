import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreationTaskDetail } from "../../src/shared/creation/contracts.js";
import { creationAppFixture } from "../support/creation-app.js";

test("owned updates, skill removal, attachments and visible progress survive an output race without duplicate replay", async () => {
  const f = await creationAppFixture();
  const ready = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const steers: string[] = [];
  try {
    f.onRun(async (_input, callbacks) => {
      await callbacks.event?.({
        kind: "message",
        id: "visible",
        text: "Reviewing the supplied requirements.",
        complete: false,
      });
      await callbacks.event?.({
        kind: "usage",
        usage: { total: { inputTokens: 100, outputTokens: 30, totalTokens: 130 }, modelContextWindow: 200000 },
      });
      callbacks.control?.({
        steer: async (text) => {
          steers.push(text);
        },
      });
      ready.resolve();
      await Promise.race([
        finish.promise,
        new Promise<void>((_, reject) =>
          callbacks.signal.addEventListener("abort", () => reject(callbacks.signal.reason), { once: true }),
        ),
      ]);
      await callbacks.event?.({
        kind: "message",
        id: "visible",
        text: "Reviewed the requirements and supplied materials.",
        complete: true,
      });
    });
    const first = await f.create("Write a requirements document.");
    expect(first.response.status).toBe(202);
    await ready.promise;
    const upload = await f.files.raw(
      "/api/creation-materials?name=fields.csv",
      "POST",
      Buffer.from("field,required\nsize,true\n"),
    );
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json();
    const supplement = {
      taskId: first.request.id,
      id: randomUUID(),
      prompt: "Keep the selected skill and include a short glossary.",
      updateGeneration: 1,
    };
    const acceptedUpdate = await f.files.call("/api/document-creations/message", "POST", supplement);
    expect(acceptedUpdate.status).toBe(202);
    expect(acceptedUpdate.body.task.id).toBe(first.request.id);
    expect(
      (
        await f.files.call("/api/document-creations/message", "POST", {
          ...supplement,
          id: randomUUID(),
          updateGeneration: 0,
        })
      ).body.code,
    ).toBe("updateClosed");
    const firstRun = f.scopes[0]!;
    const retained = await firstRun.callbacks.call({
      ...firstRun.scope,
      callId: randomUUID(),
      name: "panda_creation_context",
      arguments: {},
    });
    expect(JSON.parse(retained.text).latestSkillGuidance).not.toEqual([]);
    expect(JSON.parse(retained.text).messages[0].id).toBe(supplement.id);
    const command = {
      taskId: first.request.id,
      id: randomUUID(),
      prompt: "Add the supplied field mapping and remove earlier writing guidance.",
      selections: [],
      attachments: [{ materialId: attachment.materialId }],
    };
    const accepted = await f.files.call("/api/document-creations/message", "POST", command);
    expect(accepted.status).toBe(202);
    expect((await f.files.call("/api/document-creations/message", "POST", command)).status).toBe(202);
    expect(
      (await f.files.call("/api/document-creations/message", "POST", { ...command, prompt: "Changed body" })).status,
    ).toBe(409);
    const run = f.scopes[0]!;
    const oldSave = await f.save(run.callbacks, run.scope, "Stale content");
    expect(oldSave.success).toBe(false);
    expect(JSON.parse(oldSave.text).error).toBe("contextChanged");
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
    const context = await run.callbacks.call({
      ...run.scope,
      callId: randomUUID(),
      name: "panda_creation_context",
      arguments: {},
    });
    const decoded = JSON.parse(context.text);
    expect(decoded.latestSkillGuidance).toEqual([]);
    expect(decoded.contextVersion).toBe(command.id);
    expect(decoded.materials.map((value: { id: string }) => value.id)).toEqual([attachment.materialId]);
    const material = await run.callbacks.call({
      ...run.scope,
      callId: randomUUID(),
      name: "panda_creation_material_read",
      arguments: { id: attachment.materialId },
    });
    expect(JSON.parse(material.text).content).toContain("size,true");
    await expect(
      run.callbacks.call({
        ...run.scope,
        callId: randomUUID(),
        name: "panda_creation_material_read",
        arguments: { id: randomUUID() },
      }),
    ).rejects.toThrow();
    const long = {
      ...command,
      id: randomUUID(),
      prompt: "Detailed updates: " + "Preserve all supplied requirements. ".repeat(1000),
    };
    expect((await f.files.call("/api/document-creations/message", "POST", long)).status).toBe(202);
    await run.callbacks.call({ ...run.scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
    expect((await f.save(run.callbacks, run.scope, "Only read an excerpt")).success).toBe(false);
    let offset: number | null = 280;
    while (offset !== null) {
      const page = await run.callbacks.call({
        ...run.scope,
        callId: randomUUID(),
        name: "panda_creation_context",
        arguments: { messageId: long.id, offset },
      });
      offset = JSON.parse(page.text).nextOffset;
    }
    await Bun.sleep(600);
    const detail = (await f.files.call("/api/document-creations/detail?id=" + first.request.id)).body
      .task as CreationTaskDetail;
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages![0]!.selections).toEqual([]);
    expect(detail.usage?.total?.totalTokens).toBe(130);
    expect(detail.progress.filter((entry) => entry.stage === "message")).toHaveLength(1);
    const foreign = "operator:other";
    f.actor(foreign);
    expect((await f.files.call("/api/document-creations/detail?id=" + first.request.id)).status).toBe(404);
    expect((await f.files.raw("/api/creation-materials/original?id=" + attachment.materialId)).status).toBe(404);
    f.actor("operator:test-user");
    expect((await f.save(run.callbacks, run.scope, "Current revised content")).success).toBe(true);
    finish.resolve();
    await f.until(first.request.id, (task) => task.state === "succeeded");
    const replay = await f.files.call("/api/document-creations/message", "POST", command);
    expect(replay.status).toBe(202);
    expect(replay.body.task.id).toBe(first.request.id);
    const late = await f.files.call("/api/document-creations/message", "POST", { ...supplement, id: randomUUID() });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("updateClosed");
    expect((await f.files.call("/api/document-creations/message", "POST", supplement)).body.task.id).toBe(
      first.request.id,
    );
    expect(f.runs()).toBe(1);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
  } finally {
    finish.resolve();
    await f.close();
  }
}, 60000);
