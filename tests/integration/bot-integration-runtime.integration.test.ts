import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotIntegrations, botIntegrationCheck } from "../../src/server/bots/integrations/configuration.js";
import { BotProviders } from "../../src/server/bots/integrations/providers.js";
import { BotIntegrationWorker } from "../../src/server/bots/integrations/worker.js";
import { BotIntegrationChannel } from "../../src/server/bots/integrations/channel.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import type { BotIntegrationRunRecord } from "../../src/server/bots/integrations/run-records.js";

async function until(predicate: () => Promise<boolean>) {
  const end = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Runtime fixture did not settle");
    await Bun.sleep(10);
  }
}
test("persistent schedule resumes across worker restart, produces one channel result with the real task worker and enforces channel TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-runtime-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    configs = new BotIntegrations(store, connections),
    providers = new BotProviders(connections),
    bot = store.createBot("alice", { code: "news", name: "News Panda" });
  let models = 0;
  const modelWorker = new BotWorker(
    store,
    () => ({
      id: "fixture",
      async run(input, callbacks) {
        models++;
        const scope = { sessionId: "task-session", runId: randomUUID() };
        await callbacks.session?.(scope.sessionId);
        await callbacks.started(scope);
        await callbacks.call({
          ...scope,
          callId: "decision",
          name: "panda_bot_decide",
          arguments: {
            taskId: JSON.parse(input.prompt).taskId,
            decision: "complete",
            reason: "Verified digest from the fixture feed.",
          },
        });
        return { ...scope, status: "completed" };
      },
    }),
    join(root, "tasks"),
  );
  const sources = {
    feed: async () => ({
      items: [
        {
          id: "entry",
          title: "Source",
          text: "A sourced fact",
          url: "https://example.com/one",
          digest: "v1",
          publishedAt: Date.now(),
        },
      ],
      cursor: { etag: '"v1"' },
      limited: false,
      unchanged: false,
    }),
    inbox: async () => ({ items: [], limited: false, nextPageToken: "" }),
  };
  let integrationWorker = new BotIntegrationWorker(store, configs, providers, () => void modelWorker.tick(), sources);
  try {
    const config = await configs.save("alice", bot.id, {
      id: randomUUID(),
      revision: 0,
      name: "Morning digest",
      source: { kind: "rss", url: "https://example.com/feed" },
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      enabled: true,
      retentionDays: 30,
      delivery: { channel: true },
    });
    const fresh = await configs.row("alice", bot.id, config.config.id);
    await store.workspace.batch("alice", {
      checks: [botIntegrationCheck(fresh)],
      puts: [{ ...fresh, dueAt: Date.now() }],
    });
    await integrationWorker.close();
    integrationWorker = new BotIntegrationWorker(store, configs, providers, () => void modelWorker.tick(), sources);
    integrationWorker.start();
    modelWorker.start();
    const channel = new BotIntegrationChannel(configs);
    await until(async () => (await channel.list("alice", bot.id, config.config.id)).messages.length === 1);
    await until(async () => (await configs.row("alice", bot.id, config.config.id)).data.lastRun?.state === "complete");
    expect(models).toBe(1);
    expect(store.tasks("alice")).toHaveLength(1);
    expect((await new BotChatService(store).snapshot("alice", bot.id)).messages).toEqual([]);
    const rows = await store.workspace.list("alice", "channel-message");
    expect(rows[0]!.expiresAt! - (rows[0]!.data as { createdAt: number }).createdAt).toBe(30 * 86400000);
    const run = (await store.workspace.list<BotIntegrationRunRecord>("alice", "run"))[0]!;
    expect(run.data.view.state).toBe("complete");
    expect((await configs.row("alice", bot.id, config.config.id)).data.pendingRun).toBeNull();
    await store.workspace.batch("alice", {
      checks: [botIntegrationCheck(rows[0]!)],
      puts: [{ ...rows[0]!, expiresAt: Date.now() - 1 }],
    });
    expect((await channel.list("alice", bot.id, config.config.id)).messages).toEqual([]);
    await integrationWorker.close();
    integrationWorker = new BotIntegrationWorker(store, configs, providers, () => {}, sources);
    await integrationWorker.tick();
    expect(await store.workspace.get("alice", rows[0]!)).toBeNull();
    expect(store.tasks("alice")).toHaveLength(1);
  } finally {
    await integrationWorker.close();
    await modelWorker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
