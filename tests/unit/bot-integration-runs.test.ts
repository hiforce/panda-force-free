import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import {
  BotIntegrations,
  botIntegrationCheck,
  botIntegrationWrite,
} from "../../src/server/bots/integrations/configuration.js";
import { BotIntegrationRuns } from "../../src/server/bots/integrations/runs.js";

test("integration run submissions coalesce concurrent uncertain requests and keep preview state separate from source cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-integration-runs-")),
    store = new BotStore(":memory:"),
    configs = new BotIntegrations(store, new BotConnections(store.workspace, root)),
    runs = new BotIntegrationRuns(configs);
  try {
    const bot = store.createBot("alice", { code: "run-feed", name: "Feed Panda" }),
      other = store.createBot("alice", { code: "other-feed", name: "Other" }),
      input = {
        id: randomUUID(),
        revision: 0,
        name: "History feed",
        source: { kind: "rss", url: "https://example.com/feed" },
        schedule: { kind: "interval", minutes: 10 },
        instructions: "Summarize",
        enabled: false,
        retentionDays: 30,
        delivery: { channel: true },
      },
      saved = await configs.save("alice", bot.id, input),
      request = { requestId: randomUUID(), revision: saved.revision, preview: true },
      responses = await Promise.all(Array.from({ length: 8 }, () => runs.manual("alice", bot.id, input.id, request)));
    expect(responses.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.run.id)).size).toBe(1);
    const row = await configs.row("alice", bot.id, input.id);
    expect(row.data.cursor).toEqual({});
    expect(await store.workspace.list("alice", "source-item", { botId: bot.id })).toEqual([]);
    expect(await store.workspace.list("alice", "channel-message", { botId: bot.id })).toEqual([]);
    expect(row.dueAt).toBeNull();
    await expect(runs.manual("alice", bot.id, input.id, { ...request, preview: false })).rejects.toMatchObject({
      code: "idempotencyConflict",
    });
    await expect(runs.row("bob", bot.id, input.id, responses[0]!.run.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(runs.row("alice", other.id, input.id, responses[0]!.run.id)).rejects.toMatchObject({
      code: "notFound",
    });
    expect((await runs.cancel("alice", bot.id, input.id, responses[0]!.run.id)).state).toBe("canceled");
    expect((await runs.cancel("alice", bot.id, input.id, responses[0]!.run.id)).state).toBe("canceled");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("one scheduled slot is claimed atomically and keeps the next schedule out of the due queue while that run is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-integration-slot-")),
    store = new BotStore(":memory:"),
    configs = new BotIntegrations(store, new BotConnections(store.workspace, root)),
    runs = new BotIntegrationRuns(configs);
  try {
    const bot = store.createBot("alice", { code: "scheduled-feed", name: "Feed" }),
      now = Date.now(),
      saved = await configs.save("alice", bot.id, {
        id: randomUUID(),
        revision: 0,
        name: "Morning digest",
        source: { kind: "rss", url: "https://example.com/feed" },
        schedule: { kind: "interval", minutes: 10 },
        enabled: true,
        retentionDays: 30,
        delivery: { channel: true },
      }),
      before = await configs.row("alice", bot.id, saved.config.id);
    await store.workspace.batch("alice", {
      checks: [botIntegrationCheck(before)],
      puts: [botIntegrationWrite(before, before.data, now - 60000)],
    });
    const row = await configs.row("alice", bot.id, saved.config.id),
      claims = await Promise.allSettled([runs.scheduled(row, now), runs.scheduled(row, now)]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.workspace.list("alice", "run", { botId: bot.id })).toHaveLength(1);
    const after = await configs.row("alice", bot.id, saved.config.id);
    expect(after.dueAt).toBeNull();
    expect(after.data.resumeAt).toBe(now + 600000);
    expect((await configs.list("alice", bot.id))[0]!.nextRunAt).toBe(now + 600000);
    expect(await runs.scheduled(after, now + 1200000)).toBeNull();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("the final integration quota slot cannot be consumed by two concurrent creates", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-integration-quota-")),
    store = new BotStore(":memory:"),
    configs = new BotIntegrations(store, new BotConnections(store.workspace, root));
  try {
    const bot = store.createBot("alice", { code: "quota-feed", name: "Feed" }),
      input = () => ({
        id: randomUUID(),
        revision: 0,
        name: "Feed",
        source: { kind: "rss", url: "https://example.com/feed" },
        schedule: { kind: "interval", minutes: 10 },
        enabled: false,
        retentionDays: 30,
        delivery: { channel: true },
      });
    for (let i = 0; i < 99; i++) await configs.save("alice", bot.id, input());
    const results = await Promise.allSettled([
      configs.save("alice", bot.id, input()),
      configs.save("alice", bot.id, input()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await configs.list("alice", bot.id)).toHaveLength(100);
    await expect(configs.save("alice", bot.id, input())).rejects.toMatchObject({ code: "integrationLimit" });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
