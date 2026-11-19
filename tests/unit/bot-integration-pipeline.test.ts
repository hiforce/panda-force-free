import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotProviders } from "../../src/server/bots/integrations/providers.js";
import { BotIntegrations, botIntegrationCheck } from "../../src/server/bots/integrations/configuration.js";
import { BotIntegrationRuns } from "../../src/server/bots/integrations/runs.js";
import { BotIntegrationLease } from "../../src/server/bots/integrations/run-lease.js";
import { integrationRunWrite } from "../../src/server/bots/integrations/run-records.js";
import { collectBotIntegration } from "../../src/server/bots/integrations/collection.js";
import { processBotIntegration } from "../../src/server/bots/integrations/processing.js";
import { BotIntegrationResults } from "../../src/server/bots/integrations/results.js";
import { BotIntegrationOutbox } from "../../src/server/bots/integrations/outbox.js";
import { BotIntegrationChannel } from "../../src/server/bots/integrations/channel.js";
import type { BotIntegrationDelivery } from "../../src/server/bots/integrations/delivery-records.js";
import type { BotSourceItem } from "../../src/shared/bots/integrations.js";

async function setup(mail = false, automatic = false, unknown = false) {
  const root = await mkdtemp(join(tmpdir(), "bot-pipeline-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    sent: string[] = [],
    providers = new BotProviders(connections, async (url, options) => {
      if (url.includes("chat.postMessage") || url.endsWith("messages/send")) {
        sent.push(options.body!);
        if (unknown) throw new Error("lost acknowledgement");
      }
      const body = url.includes("auth.test")
        ? { ok: true, team_id: "T1234567", user_id: "U1234567" }
        : url.includes("oauth2")
          ? { access_token: "fixture-access", expires_in: 3600 }
          : url.endsWith("profile")
            ? { emailAddress: "panda@example.com" }
            : url.includes("messages?")
              ? {}
              : mail
                ? { id: "abc123", threadId: "thread123" }
                : { ok: true, channel: "C1234567", ts: "123.456" };
      return { status: 200, body: Buffer.from(JSON.stringify(body)) };
    }),
    config = new BotIntegrations(store, connections),
    runs = new BotIntegrationRuns(config),
    outbox = new BotIntegrationOutbox(store, providers),
    channel = new BotIntegrationChannel(config),
    bot = store.createBot("alice", { code: "panda-pipeline", name: "Panda", instructions: "Private persona" }),
    connectionId = randomUUID();
  await connections.save("alice", {
    id: connectionId,
    revision: 0,
    kind: mail ? "gmail" : "slack",
    name: "Owner connection",
    credential: mail
      ? { clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" }
      : { token: "fixture-slack" },
  });
  await providers.verify("alice", connectionId, new AbortController().signal);
  const saved = await config.save("alice", bot.id, {
    id: randomUUID(),
    revision: 0,
    name: "Digest",
    source: mail ? { kind: "gmail", connectionId, query: "" } : { kind: "rss", url: "https://example.com/feed" },
    schedule: { kind: "interval", minutes: 30 },
    enabled: true,
    retentionDays: 30,
    delivery: { channel: true, ...(!mail ? { slack: { connectionId, channel: "C1234567" } } : {}) },
    mail: { mode: automatic ? "auto" : "draft", allowSenders: ["reader@example.com"], dailyLimit: 1 },
    confirmAutoReply: true,
  });
  const sample: BotSourceItem = {
    id: "source123",
    title: "Question",
    text: "A documented question",
    url: "https://example.com/item",
    digest: "one",
    publishedAt: Date.now(),
    ...(mail
      ? {
          mail: {
            account: "panda@example.com",
            from: "reader@example.com",
            threadId: "thread123",
            messageId: "<source@example.com>",
            autoSubmitted: false,
          },
        }
      : {}),
  };
  const start = async () => {
    const fresh = await config.row("alice", bot.id, saved.config.id),
      submitted = await runs.manual("alice", bot.id, saved.config.id, {
        requestId: randomUUID(),
        revision: fresh.version,
        preview: false,
      });
    return submitted.run.id;
  };
  const claim = async (runId: string, state: "collecting" | "processing") => {
    const row = await runs.row("alice", bot.id, saved.config.id, runId),
      lease = randomUUID();
    expect(
      await store.workspace.batch("alice", {
        checks: [botIntegrationCheck(row)],
        puts: [integrationRunWrite(row, { ...row.data, lease, view: { ...row.data.view, state } }, Date.now() + 30000)],
      }),
    ).toBe(true);
    return new BotIntegrationLease(store.workspace, "alice", runId, lease);
  };
  const process = async (reason: string) => {
    const runId = await start(),
      lease = await claim(runId, "collecting");
    await collectBotIntegration(lease, providers, new AbortController().signal, {
      feed: async () => ({ items: [sample], limited: false, cursor: {}, unchanged: false }),
      inbox: async () => ({ items: [sample], limited: false, nextPageToken: "" }),
    });
    await processBotIntegration(await claim(runId, "processing"), store, new BotIntegrationResults());
    const task = store.claim()!;
    expect(task).not.toBeNull();
    expect(task.task.input.callback).toBeUndefined();
    expect(task.task.input.actions).toEqual([]);
    store.update({ ...task.task, status: "completed", decision: "complete", reason }, task.lease, true);
    await processBotIntegration(await claim(runId, "processing"), store, new BotIntegrationResults());
    return { runId, task: store.task("alice", task.task.id) };
  };
  return {
    root,
    store,
    config,
    runs,
    bot,
    saved,
    sent,
    providers,
    outbox,
    channel,
    sample,
    process,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("captured input creates isolated stable tasks, one private result and one Slack intent; retries cannot duplicate it", async () => {
  const f = await setup();
  try {
    const { runId, task } = await f.process("A careful digest <@everyone> & evidence");
    const messages = await f.channel.list("alice", f.bot.id, f.saved.config.id);
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.text).toContain("careful digest");
    const deliveries = await f.store.workspace.list<BotIntegrationDelivery>("alice", "delivery");
    expect(deliveries).toHaveLength(1);
    await Promise.all([
      f.outbox.dispatch(deliveries[0]!, new AbortController().signal),
      f.outbox.dispatch(deliveries[0]!, new AbortController().signal),
    ]);
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(f.sent[0]!).text).toContain("&lt;@everyone&gt; &amp;");
    expect(JSON.parse(f.sent[0]!).mrkdwn).toBe(false);
    expect((await f.store.workspace.get("alice", deliveries[0]!))!.state).toBe("sent");
    expect((await f.runs.row("alice", f.bot.id, f.saved.config.id, runId)).data.view.state).toBe("delivering");
    expect(task.input.input.text).toContain("A documented question");
    expect(f.store.bot("alice", f.bot.id).sessionId).toBeNull();
    await expect(f.channel.list("bob", f.bot.id, f.saved.config.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.close();
  }
});
test("mail defaults to a draft; human confirmation fixes recipient/thread and deduplicates an uncertain approval", async () => {
  const f = await setup(true);
  try {
    await f.process(JSON.stringify({ reply: "Thank you for your question.", needsReview: false }));
    expect(await f.store.workspace.list("alice", "delivery")).toEqual([]);
    const message = (await f.channel.list("alice", f.bot.id, f.saved.config.id)).messages[0]!;
    expect(message.reply!.state).toBe("draft");
    expect("source" in message).toBe(false);
    const approval = { requestId: randomUUID(), text: "Reviewed reply", confirm: true };
    const sent = await f.channel.send("alice", f.bot.id, f.saved.config.id, message.id, approval);
    expect((await f.channel.send("alice", f.bot.id, f.saved.config.id, message.id, approval)).id).toBe(sent.id);
    const delivery = (await f.store.workspace.list<BotIntegrationDelivery>("alice", "delivery"))[0]!;
    await f.outbox.dispatch(delivery, new AbortController().signal);
    expect(f.sent).toHaveLength(1);
    const raw = Buffer.from(JSON.parse(f.sent[0]!).raw, "base64url").toString();
    expect(raw).toContain("To: reader@example.com");
    expect(raw).toContain("In-Reply-To: <source@example.com>");
    expect((await f.channel.list("alice", f.bot.id, f.saved.config.id)).messages[0]!.reply!.state).toBe("sent");
    await expect(
      f.channel.send("alice", f.bot.id, f.saved.config.id, message.id, { ...approval, text: "Different" }),
    ).rejects.toMatchObject({ code: "idempotencyConflict" });
  } finally {
    await f.close();
  }
});
test("unknown mail sends retain their source reservation and cannot be retried or duplicated by another integration", async () => {
  const f = await setup(true, true, true);
  try {
    await f.process(JSON.stringify({ reply: "A factual response", needsReview: false }));
    const row = (await f.store.workspace.list<BotIntegrationDelivery>("alice", "delivery"))[0]!;
    await f.outbox.dispatch(row, new AbortController().signal);
    const unknown = (await f.store.workspace.get<BotIntegrationDelivery>("alice", row))!;
    expect(unknown.state).toBe("unknown");
    expect(f.sent).toHaveLength(1);
    await expect(f.outbox.retry("alice", f.bot.id, row.id)).rejects.toMatchObject({ code: "deliveryCannotRetry" });
    await f.outbox.dispatch(unknown, new AbortController().signal);
    expect(f.sent).toHaveLength(1);
    const key = { kind: "delivery" as const, id: row.id + "-other" };
    await f.store.workspace.batch("alice", {
      checks: [{ ...key, version: null }],
      puts: [{ ...row, ...key, state: "queued", dueAt: Date.now(), data: { ...row.data, id: randomUUID() } }],
    });
    await f.outbox.dispatch(
      (await f.store.workspace.get<BotIntegrationDelivery>("alice", key))!,
      new AbortController().signal,
    );
    expect((await f.store.workspace.get<BotIntegrationDelivery>("alice", key))!.data.failure).toBe("alreadyReplied");
    expect(f.sent).toHaveLength(1);
    expect((await f.outbox.reconcile("alice", f.bot.id, row.id, new AbortController().signal)).found).toBe(false);
  } finally {
    await f.close();
  }
});
test("source or Bot pause and task deletion before the atomic dispatch fence cannot send externally", async () => {
  for (const action of ["configuration", "bot", "task"] as const) {
    const f = await setup();
    try {
      const { task } = await f.process("Result");
      const row = (await f.store.workspace.list<BotIntegrationDelivery>("alice", "delivery"))[0]!;
      if (action === "configuration") {
        const current = await f.config.row("alice", f.bot.id, f.saved.config.id);
        await f.config.save("alice", f.bot.id, { ...current.data.config, revision: current.version, enabled: false });
      } else if (action === "bot") f.store.updateBot("alice", f.bot.id, { active: false });
      else {
        const batch = f.store.workspace.batch.bind(f.store.workspace);
        f.store.workspace.batch = async (owner, value) => {
          if (value.completedTasks?.length) f.store.db.query("DELETE FROM bot_tasks WHERE id=?").run(task.id);
          return batch(owner, value);
        };
      }
      await f.outbox.dispatch(row, new AbortController().signal);
      expect(f.sent).toEqual([]);
    } finally {
      await f.close();
    }
  }
});
test("invalid model mail output stays reviewable and never becomes an automatically sent explanation", async () => {
  const f = await setup(true, true);
  try {
    await f.process("I have sent the answer, trust me.");
    expect(await f.store.workspace.list("alice", "delivery")).toEqual([]);
    const message = (await f.channel.list("alice", f.bot.id, f.saved.config.id)).messages[0]!;
    expect(message.reply!.text).toBe("");
    expect(message.draftFailure).toBe("invalidDraft");
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test("losing the database receipt after provider acknowledgement cannot downgrade a successful send into a retryable rejection", async () => {
  const f = await setup(true, true);
  try {
    await f.process(JSON.stringify({ reply: "A factual reply", needsReview: false }));
    const row = (await f.store.workspace.list<BotIntegrationDelivery>("alice", "delivery"))[0]!,
      batch = f.store.workspace.batch.bind(f.store.workspace);
    let lost = false;
    f.store.workspace.batch = async (owner, value) => {
      if (!lost && value.puts?.some((entry) => entry.kind === "delivery" && entry.state === "sent")) {
        lost = true;
        throw new Error("Database acknowledgement lost");
      }
      return batch(owner, value);
    };
    await expect(f.outbox.dispatch(row, new AbortController().signal)).rejects.toThrow("Database acknowledgement lost");
    expect(f.sent).toHaveLength(1);
    const dispatched = (await f.store.workspace.get<BotIntegrationDelivery>("alice", row))!;
    expect(dispatched.state).toBe("dispatching");
    await batch("alice", {
      checks: [botIntegrationCheck(dispatched)],
      puts: [{ ...dispatched, dueAt: Date.now() - 1 }],
    });
    await f.outbox.recover((await f.store.workspace.get<BotIntegrationDelivery>("alice", row))!);
    expect((await f.store.workspace.get<BotIntegrationDelivery>("alice", row))!.state).toBe("unknown");
    await expect(f.outbox.retry("alice", f.bot.id, row.id)).rejects.toMatchObject({ code: "deliveryCannotRetry" });
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});
