import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";

test("completion messages survive restart, respect project/owner scope and acknowledge idempotently", async () => {
  const f = await creationAppFixture();
  try {
    const { request } = await f.create("Write a deliverable while I am away");
    const saved = await f.until(request.id, (t) => t.state === "succeeded");
    let response = await f.files.call("/api/document-creations/notifications");
    expect(response.status).toBe(200);
    expect(response.body.unreadCount).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].artifact).toEqual(saved.artifact);
    const receipt = { taskId: request.id, generation: saved.generation };
    expect((await f.files.call("/api/document-creations/notifications/read", "POST", receipt)).status).toBe(200);
    response = await f.files.call("/api/document-creations/notifications");
    const readAt = response.body.items[0].readAt;
    expect(readAt).toBeGreaterThan(0);
    expect(response.body.unreadCount).toBe(0);
    await f.restart();
    expect((await f.files.call("/api/document-creations/notifications/read", "POST", receipt)).status).toBe(200);
    expect((await f.files.call("/api/document-creations/notifications")).body.items[0].readAt).toBe(readAt);
    f.actor("operator:another");
    expect((await f.files.call("/api/document-creations/notifications")).body.items).toEqual([]);
    expect((await f.files.call("/api/document-creations/notifications/read", "POST", receipt)).status).toBe(404);
    f.actor("operator:test-user");
    f.files.grants.delete("project-1");
    expect((await f.files.call("/api/document-creations/notifications")).body.items).toEqual([]);
    expect((await f.files.call("/api/document-creations/notifications/read", "POST", receipt)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);

test("failed, stalled and cancelled work never advertises an unsaved deliverable", async () => {
  const f = await creationAppFixture();
  try {
    f.onRun(async () => {
      throw Object.assign(new Error("Private engine context"), { code: "APPLICATION_ENGINE_INACTIVE" });
    });
    const first = await f.create("A stalled task must remain retryable");
    const failed = await f.until(first.request.id, (t) => t.state === "failed");
    expect(failed.failure).toBe("inactive");
    expect((await f.files.call("/api/document-creations/notifications")).body.items).toEqual([]);
    f.onRun(async (_input, callbacks) => {
      await new Promise<void>((resolve) => callbacks.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const next = await f.create("A cancelled task");
    await f.until(next.request.id, (t) => t.state === "running");
    await f.files.call("/api/document-creations/cancel", "POST", { id: next.request.id });
    expect((await f.files.call("/api/document-creations/notifications")).body.items).toEqual([]);
    expect(
      (
        await f.files.call("/api/document-creations/notifications/read", "POST", {
          taskId: randomUUID(),
          generation: 1,
        })
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);
