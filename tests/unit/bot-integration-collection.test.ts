import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotError } from "../../src/shared/bots/contracts.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotProviders } from "../../src/server/bots/integrations/providers.js";
import { BotIntegrations, botIntegrationCheck } from "../../src/server/bots/integrations/configuration.js";
import { BotIntegrationRuns } from "../../src/server/bots/integrations/runs.js";
import { BotIntegrationLease } from "../../src/server/bots/integrations/run-lease.js";
import {
  collectBotIntegration,
  type BotIntegrationSourcePorts,
} from "../../src/server/bots/integrations/collection.js";
import { integrationRunWrite } from "../../src/server/bots/integrations/run-records.js";
import type { BotSourceItem } from "../../src/shared/bots/integrations.js";

async function fixture(preview: boolean) {
  const root = await mkdtemp(join(tmpdir(), "bot-collection-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    providers = new BotProviders(connections),
    configs = new BotIntegrations(store, connections),
    runs = new BotIntegrationRuns(configs),
    bot = store.createBot("alice", { code: "feed-panda", name: "Feed Panda" }),
    saved = await configs.save("alice", bot.id, {
      id: randomUUID(),
      revision: 0,
      name: "Feed",
      source: { kind: "rss", url: "https://example.com/feed" },
      schedule: { kind: "interval", minutes: 30 },
      enabled: true,
      retentionDays: 30,
      delivery: { channel: true },
    }),
    submitted = await runs.manual("alice", bot.id, saved.config.id, {
      requestId: randomUUID(),
      revision: saved.revision,
      preview,
    }),
    row = await runs.row("alice", bot.id, saved.config.id, submitted.run.id),
    leaseId = randomUUID();
  await store.workspace.batch("alice", {
    checks: [botIntegrationCheck(row)],
    puts: [
      integrationRunWrite(
        row,
        { ...row.data, lease: leaseId, view: { ...row.data.view, state: "collecting" } },
        Date.now() + 30000,
      ),
    ],
  });
  return {
    store,
    configs,
    runs,
    providers,
    bot,
    saved,
    submitted,
    lease: new BotIntegrationLease(store.workspace, "alice", row.id, leaseId),
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const sample: BotSourceItem = {
  id: "source-one",
  title: "History",
  text: "A documented event",
  url: "https://example.com/one",
  publishedAt: null,
  digest: "content-one",
};
const ports = (feed: BotIntegrationSourcePorts["feed"]): BotIntegrationSourcePorts => ({
  feed,
  inbox: async () => {
    throw new Error("Feed capture must not open a mailbox");
  },
});

test("preview captures bounded sources without consuming their cursor or starting models, channels or deliveries", async () => {
  const f = await fixture(true);
  try {
    const original = await f.configs.row("alice", f.bot.id, f.saved.config.id);
    await collectBotIntegration(
      f.lease,
      f.providers,
      new AbortController().signal,
      ports(async () => ({ items: [sample], cursor: { etag: '"new"' }, unchanged: false, limited: false })),
    );
    const result = await f.runs.row("alice", f.bot.id, f.saved.config.id, f.submitted.run.id),
      config = await f.configs.row("alice", f.bot.id, f.saved.config.id);
    expect(result.data.view).toMatchObject({ preview: true, state: "complete", itemCount: 1 });
    expect(config.data.cursor).toEqual(original.data.cursor);
    expect(config.data.pendingRun).toBeNull();
    expect(config.dueAt).toBe(original.data.resumeAt!);
    for (const kind of ["source-item", "channel-message", "delivery"] as const)
      expect(await f.store.workspace.list("alice", kind)).toEqual([]);
    expect(f.store.tasks("alice")).toEqual([]);
  } finally {
    await f.close();
  }
});
test("normal capture persists raw evidence, hash-only deduplication and validators atomically, then relinquishes the source lease", async () => {
  const f = await fixture(false);
  let calls = 0;
  try {
    const source = ports(async () => {
      calls++;
      return { items: [sample], cursor: { etag: '"v1"' }, unchanged: false, limited: false };
    });
    await collectBotIntegration(f.lease, f.providers, new AbortController().signal, source);
    await collectBotIntegration(f.lease, f.providers, new AbortController().signal, source);
    const row = await f.runs.row("alice", f.bot.id, f.saved.config.id, f.submitted.run.id),
      config = await f.configs.row("alice", f.bot.id, f.saved.config.id);
    expect(row.data.view.state).toBe("processing");
    expect(row.data.items).toEqual([sample]);
    expect(row.data.parts).toEqual([{ itemIds: [sample.id], applied: false }]);
    expect(row.data.lease).toBeUndefined();
    expect(calls).toBe(1);
    expect(config.data.cursor).toEqual({ etag: '"v1"' });
    const ledgers = await f.store.workspace.list("alice", "source-item");
    expect(ledgers).toHaveLength(1);
    expect(JSON.stringify(ledgers)).not.toContain("A documented event");
    expect(f.store.tasks("alice")).toEqual([]);
  } finally {
    await f.close();
  }
});
test("pausing while a feed read is in flight fences its cursor, ledger and late captured content", async () => {
  const f = await fixture(false);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  try {
    const work = collectBotIntegration(
      f.lease,
      f.providers,
      new AbortController().signal,
      ports(async () => {
        entered();
        await held;
        return { items: [sample], cursor: { etag: '"late"' }, unchanged: false, limited: false };
      }),
    );
    await started;
    const config = await f.configs.row("alice", f.bot.id, f.saved.config.id);
    await f.configs.save("alice", f.bot.id, { ...config.data.config, revision: config.version, enabled: false });
    release();
    await work;
    expect(await f.lease.current()).toBeNull();
    expect((await f.configs.row("alice", f.bot.id, f.saved.config.id)).data.cursor).toEqual({});
    expect(await f.store.workspace.list("alice", "source-item")).toEqual([]);
    expect((await f.runs.row("alice", f.bot.id, f.saved.config.id, f.submitted.run.id)).data.items).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});
test("source failure records an actionable failure without advancing the source or claiming successful emptiness", async () => {
  const f = await fixture(false);
  try {
    await collectBotIntegration(
      f.lease,
      f.providers,
      new AbortController().signal,
      ports(async () => {
        throw new BotError("sourceRateLimited", 429);
      }),
    );
    const result = await f.runs.row("alice", f.bot.id, f.saved.config.id, f.submitted.run.id);
    expect(result.data.view).toMatchObject({ state: "failed", failure: "sourceRateLimited", itemCount: 0 });
    expect((await f.configs.row("alice", f.bot.id, f.saved.config.id)).data.pendingRun).toBeNull();
    expect(f.store.tasks("alice")).toEqual([]);
  } finally {
    await f.close();
  }
});
test("large multilingual captures stay within a bounded durable record rather than failing at a small-chat limit", async () => {
  const f = await fixture(false);
  try {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...sample,
      id: "source-" + index,
      text: "历史".repeat(1750),
      digest: "digest-" + index,
    }));
    await collectBotIntegration(
      f.lease,
      f.providers,
      new AbortController().signal,
      ports(async () => ({ items, cursor: {}, unchanged: false, limited: false })),
    );
    const result = await f.runs.row("alice", f.bot.id, f.saved.config.id, f.submitted.run.id);
    expect(result.data.view.state).toBe("processing");
    expect(result.data.items).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeGreaterThan(512000);
    const key = { kind: "run" as const, id: randomUUID() };
    await expect(
      f.store.workspace.batch("alice", {
        checks: [{ ...key, version: null }],
        puts: [
          {
            ...key,
            botId: f.bot.id,
            state: "queued",
            dueAt: 0,
            expiresAt: null,
            data: { text: "x".repeat(2 * 1024 * 1024) },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
  } finally {
    await f.close();
  }
});
