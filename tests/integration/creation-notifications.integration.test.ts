import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";

test("registered integrations add user-owned descriptions and links to the common inbox", async () => {
  const owner = "operator:test-user";
  const actions = ["https://example.test/releases/42", "/settings/storage", "javascript:alert(1)", "//example.test"];
  const records = actions.map((href, index) => ({
    id: "release-" + index,
    title: "Release " + index,
    description: "Build is ready\n<em>Details</em>",
    createdAt: Date.now() + 100000 - index,
    readAt: null as number | null,
    action: { type: "link" as const, href },
  }));
  let available = true;
  const f = await creationAppFixture({
    notificationSources: [
      {
        id: "release-service",
        async preview(actor) {
          if (!available) throw new Error("Integration temporarily unavailable");
          const items = actor === owner ? records : [];
          return { items, unreadCount: items.filter((item) => item.readAt === null).length };
        },
        async history(actor) {
          return { items: actor === owner ? records : [], more: false };
        },
        async read(actor, id) {
          const item = actor === owner && records.find((item) => item.id === id);
          if (!item) return false;
          item.readAt ??= Date.now();
          return true;
        },
      },
    ],
  });
  try {
    const { request } = await f.create("Create a result to include in the notification center");
    const saved = await f.until(request.id, (task) => task.state === "succeeded");
    const response = await f.files.call("/api/notifications?view=history");
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(5);
    expect(response.body.items[0]).toMatchObject({
      source: "release-service",
      description: records[0]!.description,
      action: records[0]!.action,
    });
    expect(response.body.items[1].action).toEqual(records[1]!.action);
    expect(response.body.items[2].action).toBeUndefined();
    expect(response.body.items[3].action).toBeUndefined();
    expect(response.body.items[4]).toMatchObject({
      source: "creation",
      action: { type: "intent", name: "creation.deliverable", data: saved.artifact },
    });
    expect(response.body.nextCursor).toBeNull();
    expect((await f.files.call("/api/notifications?view=history&cursor=invalid")).status).toBe(400);
    const read = { source: "release-service", id: records[0]!.id };
    expect((await f.files.call("/api/notifications/read", "POST", read, { origin: "https://other.test" })).status).toBe(
      403,
    );
    expect((await f.files.call("/api/notifications/read", "POST", read)).status).toBe(200);
    expect((await f.files.call("/api/notifications?view=preview")).body.unreadCount).toBe(4);
    available = false;
    const degraded = await f.files.call("/api/notifications?view=preview");
    expect(degraded.status).toBe(200);
    expect(degraded.body.partial).toBe(true);
    expect(degraded.body.items.map((item: { source: string }) => item.source)).toEqual(["creation"]);
    available = true;
    f.actor("operator:another");
    expect((await f.files.call("/api/notifications?view=preview")).body).toEqual({ items: [], unreadCount: 0 });
    expect((await f.files.call("/api/notifications/read", "POST", read)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);

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
    const preview = await f.files.call("/api/document-creations/notifications?view=preview");
    expect(preview.body).toEqual(response.body);
    const history = await f.files.call("/api/document-creations/notifications?view=history");
    expect(history.body).toEqual({ items: response.body.items, nextCursor: null });
    expect((await f.files.call("/api/document-creations/notifications?view=history&cursor=invalid")).status).toBe(400);
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
    expect((await f.files.call("/api/document-creations/notifications?view=history")).body.items).toEqual([]);
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
