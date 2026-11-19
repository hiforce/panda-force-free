import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../src/server/http/router.js";
import { createBotFeature } from "../../src/server/bots/feature.js";

test("Bot workspace APIs scope single chat to the application owner and reject cross-site writes and malformed payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-workspace-api-")),
    feature = createBotFeature({
      stateRoot: root,
      version: "test",
      connection: { mode: "isolated" },
      owner: (c) => String(c.req.headers["x-test-owner"] ?? "alice"),
      chatEngine: () => ({
        id: "fixture",
        async run(_input, callbacks) {
          const scope = { sessionId: "owned-chat", runId: "reply-one" };
          await callbacks.session?.(scope.sessionId);
          await callbacks.started(scope);
          await callbacks.call({
            ...scope,
            callId: "reply",
            name: "panda_bot_chat_reply",
            arguments: { text: "Private answer" },
          });
          return { ...scope, status: "completed" };
        },
        async forget() {},
      }),
      engine: () => {
        throw new Error("Workspace navigation must not execute background tasks");
      },
    }),
    dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://localhost") }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port,
    call = (path: string, body?: unknown, owner = "alice", origin = base) =>
      fetch(base + "/api/bots" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-test-owner": owner, Origin: origin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  try {
    const created = await call("", { code: "owner-chat", name: "Private Panda", instructions: "Private rules" });
    expect(created.status).toBe(201);
    const bot = (await created.json()).bot,
      path = "/" + bot.id + "/chat";
    expect((await call("/" + bot.id)).status).toBe(200);
    expect((await call("/" + bot.id, undefined, "bob")).status).toBe(404);
    const overview = await (await call("/workspace")).json();
    expect(overview.cards[0].bot.instructions).toBeUndefined();
    expect(overview.cards[0].bot.sessionId).toBeUndefined();
    expect((await (await call("/workspace", undefined, "bob")).json()).cards).toEqual([]);
    const navigation = await (await call("/navigation")).json();
    expect(navigation.bots).toHaveLength(1);
    expect(Object.keys(navigation.bots[0]).sort()).toEqual(["avatar", "id", "name"]);
    expect((await (await call("/navigation", undefined, "bob")).json()).bots).toEqual([]);
    expect((await call(path, undefined, "bob")).status).toBe(404);
    expect((await call(path + "?before=-1")).status).toBe(400);
    const message = { requestId: randomUUID(), generation: 1, text: "Private human input" };
    expect((await call(path, message, "alice", "https://outside.invalid")).status).toBe(403);
    expect((await call(path, { ...message, generation: 0 })).status).toBe(400);
    expect((await call(path, { ...message, sessionId: "foreign-session" })).status).toBe(400);
    expect((await call(path, message)).status).toBe(202);
    expect((await call(path, message)).status).toBe(200);
    const clear = { requestId: randomUUID(), generation: 1 };
    expect((await call(path + "/clear", clear, "bob")).status).toBe(404);
    expect((await call(path + "/clear", clear)).status).toBe(202);
    expect((await call(path + "/clear", clear)).status).toBe(200);
    expect((await call(path, message)).status).toBe(409);
    expect((await call(path + "/cleanup/retry", { foreign: true })).status).toBe(400);
    expect((await (await call(path)).json()).messages).toEqual([]);
  } finally {
    await feature.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
