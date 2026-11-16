import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { createRouter } from "../../src/server/http/router.js";

test("HTTP bot API authenticates without browser login, scopes keys, deduplicates and isolates owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-api-"));
  const feature = createBotFeature({
    stateRoot: root,
    version: "test",
    connection: { mode: "isolated" },
    owner: (context) => String(context.req.headers["x-test-owner"] ?? "alice"),
    engine: () => ({
      id: "fixture",
      async run(_input, callbacks) {
        await callbacks.session?.("fixture-session");
        await callbacks.started({ sessionId: "fixture-session", runId: "fixture-run" });
        return { sessionId: "fixture-session", runId: "fixture-run", status: "completed" };
      },
    }),
  });
  const dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      const context = { req, res, url: new URL(req.url!, "http://localhost") };
      void (async () => {
        if (await feature.handle(context)) return;
        if (await dispatch(context)) return;
        res.writeHead(404).end();
      })();
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const bot = (
      await call("/api/bots", "POST", {
        code: "review-products",
        name: "Review products",
        callbackHosts: ["era.example.com"],
      })
    ).value.bot;
    const other = (await call("/api/bots", "POST", { code: "other-bot", name: "Other bot" })).value.bot;
    const key = (await call("/api/bots/keys", "POST", { name: "ERA", botIds: [bot.id], days: 1 })).value;
    const editPath = "/api/bots/" + bot.id;
    expect(
      (await call(editPath, "PATCH", { callbackHosts: ["new.example.com"] }, { "x-test-owner": "bob" })).status,
    ).toBe(404);
    expect(
      (await call(editPath, "PATCH", { name: "Invalid partial edit", callbackHosts: ["https://new.example.com"] }))
        .status,
    ).toBe(400);
    expect((await call(editPath, "PATCH", { code: "changed-code" })).status).toBe(400);
    expect((await call(editPath, "PATCH", { active: "false" })).status).toBe(400);
    const unchanged = (await call("/api/bots")).value.bots.find((item: { id: string }) => item.id === bot.id);
    expect(unchanged).toEqual(bot);
    const edited = await call(editPath, "PATCH", {
      name: "Edited product reviewer",
      model: "model-two",
      instructions: "Keep uncertain items for review",
      callbackHosts: ["new.example.com"],
      active: false,
    });
    expect(edited.status).toBe(200);
    expect(edited.value.bot).toEqual({
      ...bot,
      name: "Edited product reviewer",
      model: "model-two",
      instructions: "Keep uncertain items for review",
      callbackHosts: ["new.example.com"],
      active: false,
    });
    expect((await call(editPath, "PATCH", { callbackHosts: ["final.example.com"] })).value.bot).toEqual({
      ...edited.value.bot,
      callbackHosts: ["final.example.com"],
    });
    const path = `/api/v1/bots/${bot.code}/tasks`,
      input = {
        title: "【预处理】品牌: VANS 货号: VN00H4XBA5 批次: batch-01",
        externalTaskId: "era-1",
        instructions: "Review if uncertain",
        input: { text: "Product", images: [] },
      };
    expect((await call(path, "POST", input)).status).toBe(401);
    const headers = { authorization: "Bearer " + key.secret, "idempotency-key": "era-1" };
    const callbackInput = (host: string) => ({
      ...input,
      callbacks: { discard: { url: `https://${host}/discard`, method: "POST", body: { id: "era-1" } } },
    });
    expect((await call(path, "POST", callbackInput("era.example.com"), headers)).status).toBe(403);
    const callbackTask = await call(path, "POST", callbackInput("final.example.com"), {
      ...headers,
      "idempotency-key": "callback-task",
    });
    expect(callbackTask.status).toBe(202);
    await call(editPath, "PATCH", { callbackHosts: [] });
    expect((await call("/api/bots/tasks/" + callbackTask.value.task.id)).value.task.input.callbacks.discard.url).toBe(
      "https://final.example.com/discard",
    );
    const first = await call(path, "POST", input, headers);
    expect(first.status).toBe(202);
    expect(first.value.task.title).toBe(input.title);
    expect((await call("/api/bots/tasks/" + first.value.task.id)).value.task.title).toBe(input.title);
    const queue = await call("/api/bots/queue?limit=25&q=" + encodeURIComponent(input.title));
    expect(queue.status).toBe(200);
    expect(queue.value.tasks.map((task: { title: string }) => task.title)).toContain(input.title);
    expect(queue.value.tasks[0].input).toBeUndefined();
    expect((await call("/api/bots/queue?limit=1000")).status).toBe(400);
    expect((await call("/api/bots/queue", "GET", undefined, { "x-test-owner": "bob" })).value.total).toBe(0);
    expect((await call("/api/bots/retention")).value.days).toBe(5);
    expect((await call("/api/bots/retention", "POST", { days: 7 })).value.days).toBe(7);
    expect((await call("/api/bots/retention", "POST", { days: 0 })).status).toBe(400);
    expect(
      (await call("/api/bots/retention", "POST", { days: 8 }, { origin: "https://untrusted.example" })).status,
    ).toBe(403);
    expect((await call("/api/bots/retention", "GET", undefined, { "x-test-owner": "bob" })).value.days).toBe(5);
    expect((await call(path, "POST", input, headers)).value.task.id).toBe(first.value.task.id);
    expect((await call(path, "POST", { ...input, instructions: "Different" }, headers)).status).toBe(409);
    expect((await call(`/api/v1/bots/${other.code}/tasks`, "POST", input, headers)).status).toBe(403);
    expect(
      (await call(`/api/bots/tasks/${first.value.task.id}`, "GET", undefined, { "x-test-owner": "bob" })).status,
    ).toBe(404);
    expect((await call(path + "/" + first.value.task.id, "GET", undefined, headers)).status).toBe(200);
    const localDelete = "/api/bots/tasks/" + first.value.task.id;
    expect((await call(localDelete, "DELETE", undefined, { "x-test-owner": "bob" })).status).toBe(404);
    expect((await call(path + "/" + first.value.task.id, "DELETE", undefined, headers)).status).toBe(405);
    expect((await call(localDelete, "DELETE")).status).toBe(200);
    expect((await call(localDelete)).status).toBe(404);
    expect((await call(path + "/" + first.value.task.id, "GET", undefined, headers)).status).toBe(404);
    const replay = await call(path, "POST", input, headers);
    expect(replay.status).toBe(409);
    expect(replay.value.error.code).toBe("taskDeleted");
    expect((await call("/api/bots/keys/" + key.key.id, "DELETE")).status).toBe(200);
    expect((await call(path + "/" + first.value.task.id, "GET", undefined, headers)).status).toBe(401);
  } finally {
    await feature.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
