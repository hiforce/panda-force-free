import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { createBotIntegrationFeature } from "../../src/server/bots/integrations/feature.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotProviders } from "../../src/server/bots/integrations/providers.js";
import { createRouter } from "../../src/server/http/router.js";

test("integration API keeps connections private, checks origins and Bot ownership, and offers a side-effect-free preview with recoverable idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-integrations-api-")),
    store = new BotStore(":memory:"),
    bot = store.createBot("alice", { code: "feeds", name: "Feeds" }),
    other = store.createBot("alice", { code: "other", name: "Other" }),
    connections = new BotConnections(store.workspace, root),
    providers = new BotProviders(connections, async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ ok: true, team_id: "T1234567", user_id: "U1234567" })),
    })),
    feature = createBotIntegrationFeature({
      stateRoot: root,
      store,
      owner: (c) => String(c.req.headers["x-owner"] || "alice"),
      wakeTasks() {},
      providers,
      sources: {
        feed: async () => ({
          items: [
            {
              id: "source",
              title: "History",
              text: "Source evidence",
              url: "https://example.com/source",
              digest: "v1",
              publishedAt: null,
            },
          ],
          cursor: { etag: '"v1"' },
          limited: false,
          unchanged: false,
        }),
        inbox: async () => ({ items: [], limited: false, nextPageToken: "" }),
      },
    }),
    dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://localhost") }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = (path: string, body?: unknown, owner = "alice", origin = base) =>
    fetch(base + "/api/bots" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-owner": owner, Origin: origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const connectionId = randomUUID(),
      payload = {
        id: connectionId,
        revision: 0,
        name: "Slack",
        kind: "slack",
        credential: { token: "fixture-only-secret" },
      };
    expect((await call("/connections", payload, "alice", "https://outside.invalid")).status).toBe(403);
    const saved = await call("/connections", payload);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("fixture-only-secret");
    expect((await call("/connections/" + connectionId + "/test", {}, "bob")).status).toBe(404);
    expect((await call("/connections/" + connectionId + "/test", {})).status).toBe(200);
    expect((await (await call("/connections", undefined, "bob")).json()).connections).toEqual([]);
    const integrationId = randomUUID(),
      path = "/" + bot.id + "/integrations",
      config = {
        id: integrationId,
        revision: 0,
        name: "News",
        source: { kind: "rss", url: "https://example.com/feed" },
        schedule: { kind: "interval", minutes: 30 },
        enabled: false,
        retentionDays: 30,
        delivery: { channel: true },
      };
    expect((await call(path, config, "bob")).status).toBe(404);
    const configured = await call(path, config);
    expect(configured.status).toBe(200);
    const view = (await configured.json()).integration;
    expect((await call("/" + other.id + "/integrations/" + integrationId + "/channel")).status).toBe(404);
    const runPath = path + "/" + integrationId + "/runs",
      request = { requestId: randomUUID(), preview: true, revision: view.revision },
      response = await call(runPath, request);
    expect(response.status).toBe(200);
    const submitted = await response.json();
    expect((await (await call(runPath, request)).json()).run.id).toBe(submitted.run.id);
    let preview;
    for (let i = 0; i < 100; i++) {
      preview = await (await call(runPath + "/" + encodeURIComponent(submitted.run.id))).json();
      if (preview.run.state === "complete") break;
      await Bun.sleep(5);
    }
    expect(preview.run.state).toBe("complete");
    expect(preview.items[0].text).toBe("Source evidence");
    for (const kind of ["source-item", "channel-message", "delivery"] as const)
      expect(await store.workspace.list("alice", kind)).toEqual([]);
    expect(store.tasks("alice")).toEqual([]);
    expect((await call(runPath + "/" + encodeURIComponent(submitted.run.id), undefined, "bob")).status).toBe(404);
  } finally {
    await feature.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
