import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotProviders } from "../../src/server/bots/integrations/providers.js";
import { BotIntegrations } from "../../src/server/bots/integrations/configuration.js";
import { botRequest } from "../../src/server/bots/network.js";

const json = (value: unknown, status = 200, headers?: Record<string, string>) => ({
  status,
  headers,
  type: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});
test("reusable Bot connections encrypt credentials, enforce owner binding, retain secrets on metadata edits and refuse replacement of a lost key", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-connections-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root);
  try {
    const id = randomUUID(),
      value = { id, revision: 0, name: "Team Slack", kind: "slack", credential: { token: "fixture-private-token" } },
      view = await connections.save("alice", value);
    expect(view.state).toBe("unverified");
    expect(JSON.stringify(await connections.list("alice"))).not.toContain("fixture-private-token");
    expect(JSON.stringify(await store.workspace.list("alice", "connection"))).not.toContain("fixture-private-token");
    await expect(connections.row("bob", id)).rejects.toMatchObject({ code: "connectionNotFound" });
    const row = await connections.row("alice", id);
    expect((await connections.open("alice", row)).token).toBe("fixture-private-token");
    await expect(connections.open("bob", row)).rejects.toBeInstanceOf(Error);
    const edited = await connections.save("alice", {
      id,
      revision: view.revision,
      kind: "slack",
      name: "Renamed",
      enabled: false,
    });
    expect(edited.state).toBe("disabled");
    expect((await connections.open("alice", await connections.row("alice", id))).token).toBe("fixture-private-token");
    await expect(connections.save("alice", { ...value, revision: view.revision })).rejects.toMatchObject({
      code: "staleConnection",
    });
    await unlink(join(root, "config", "bot-connection-key"));
    await expect(connections.open("alice", await connections.row("alice", id))).rejects.toMatchObject({
      code: "connectionKeyUnavailable",
    });
    expect(await Bun.file(join(root, "config", "bot-connection-key")).exists()).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("Slack delivery uses the verified owner connection, stable message identity and conservative unknown-result receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-slack-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    signal = new AbortController().signal;
  try {
    const connection = await connections.save("alice", {
      id: randomUUID(),
      revision: 0,
      name: "Slack",
      kind: "slack",
      credential: { token: "fixture-slack-token" },
    });
    let mode = "success",
      posts = 0;
    const provider = new BotProviders(connections, async (url, options) => {
      expect(new URL(url).origin).toBe("https://slack.com");
      expect(options.headers?.authorization).toBe("Bearer fixture-slack-token");
      if (url.endsWith("auth.test")) return json({ ok: true, user_id: "U12345678", team_id: "T12345678" });
      posts++;
      if (mode === "fatal") return json({ ok: false, error: "fatal_error" });
      if (mode === "internal") return json({ ok: false, error: "internal_error" });
      if (mode === "rejected") return json({ ok: false, error: "channel_not_found" });
      const body = JSON.parse(options.body!);
      expect(body).toMatchObject({
        channel: "C12345678",
        text: "A private digest",
        unfurl_links: false,
        unfurl_media: false,
      });
      expect(body.client_msg_id).toMatch(/^[a-f0-9-]{36}$/);
      if (mode === "unknown") throw new Error("Socket closed after dispatch");
      if (mode === "limit") return json({}, 429, { "retry-after": "120" });
      return json({ ok: true, channel: "C12345678", ts: "123456789.0001" });
    });
    await expect(
      provider.slack("alice", connection.id, "C12345678", "A private digest", randomUUID(), signal),
    ).rejects.toMatchObject({ code: "connectionUnavailable" });
    expect((await provider.verify("alice", connection.id, signal)).state).toBe("ready");
    expect(await provider.slack("alice", connection.id, "C12345678", "A private digest", randomUUID(), signal)).toEqual(
      { id: "123456789.0001", channel: "C12345678" },
    );
    mode = "unknown";
    await expect(
      provider.slack("alice", connection.id, "C12345678", "A private digest", randomUUID(), signal),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(posts).toBe(2);
    mode = "limit";
    await expect(
      provider.slack("alice", connection.id, "C12345678", "A private digest", randomUUID(), signal),
    ).rejects.toMatchObject({ code: "rateLimited", outcome: "rejected", retryAfter: 120 });
    await expect(
      provider.slack("bob", connection.id, "C12345678", "A private digest", randomUUID(), signal),
    ).rejects.toMatchObject({ code: "connectionNotFound" });
    expect(posts).toBe(3);
    for (const response of ["fatal", "internal", "rejected"]) {
      mode = response;
      await expect(
        provider.slack("alice", connection.id, "C12345678", "A private digest", randomUUID(), signal),
      ).rejects.toMatchObject({ outcome: response === "rejected" ? "rejected" : "unknown" });
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("Gmail refresh is fenced, cached in encrypted storage and does not blindly retry a lost token-exchange result", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-gmail-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    signal = new AbortController().signal;
  try {
    const connection = await connections.save("alice", {
      id: randomUUID(),
      revision: 0,
      name: "Mailbox",
      kind: "gmail",
      credential: { clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" },
    });
    let refreshes = 0;
    const provider = new BotProviders(connections, async (url, options) => {
      if (url === "https://oauth2.googleapis.com/token") {
        refreshes++;
        expect(new URLSearchParams(options.body).get("refresh_token")).toBe("fixture-refresh");
        return json({ access_token: "fixture-access", expires_in: 3600 });
      }
      expect(url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/")).toBe(true);
      expect(options.headers?.authorization).toBe("Bearer fixture-access");
      return url.endsWith("profile") ? json({ emailAddress: "panda@example.com" }) : json({ messages: [] });
    });
    expect((await provider.verify("alice", connection.id, signal)).account).toBe("panda@example.com");
    await provider.gmail("alice", connection.id, "messages?maxResults=10", signal);
    expect(refreshes).toBe(1);
    expect(JSON.stringify(await store.workspace.list("alice", "connection"))).not.toContain("fixture-access");
    const another = await connections.save("alice", {
      id: randomUUID(),
      revision: 0,
      name: "Uncertain mailbox",
      kind: "gmail",
      credential: { clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" },
    });
    let attempts = 0;
    const failing = new BotProviders(connections, async () => {
      attempts++;
      throw new Error("Connection lost");
    });
    await expect(failing.verify("alice", another.id, signal)).rejects.toMatchObject({ outcome: "unknown" });
    await expect(failing.verify("alice", another.id, signal)).rejects.toMatchObject({ code: "connectionUnavailable" });
    expect(attempts).toBe(1);
    expect((await connections.row("alice", another.id)).data.state).toBe("error");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("integration configuration scopes connections and Bot identity and requires explicit consent for a changed auto-reply policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-integration-config-")),
    store = new BotStore(":memory:"),
    connections = new BotConnections(store.workspace, root),
    service = new BotIntegrations(store, connections);
  try {
    const bot = store.createBot("alice", { code: "research", name: "Research Panda" }),
      other = store.createBot("alice", { code: "other", name: "Other Panda" }),
      input = {
        id: randomUUID(),
        revision: 0,
        name: "History digest",
        source: { kind: "rss", url: "https://example.com/feed" },
        schedule: { kind: "interval", minutes: 30 },
        instructions: "Summarize with source links.",
        enabled: true,
        retentionDays: 30,
        delivery: { channel: true },
      },
      saved = await service.save("alice", bot.id, input);
    expect(saved.config.mail.mode).toBe("draft");
    expect(saved.nextRunAt).toBeGreaterThan(Date.now());
    await expect(service.list("alice", bot.code)).rejects.toMatchObject({ code: "notFound" });
    await expect(service.row("alice", other.id, input.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(service.list("bob", bot.id)).rejects.toMatchObject({ code: "notFound" });
    const paused = await service.save("alice", bot.id, { ...input, revision: saved.revision, enabled: false });
    expect(paused.nextRunAt).toBeNull();
    expect((await service.row("alice", bot.id, input.id)).data.generation).toBe(2);
    const mailbox = await connections.save("alice", {
        id: randomUUID(),
        revision: 0,
        name: "Mailbox",
        kind: "gmail",
        credential: { clientId: "a", clientSecret: "b", refreshToken: "c" },
      }),
      auto = {
        ...input,
        id: randomUUID(),
        source: { kind: "gmail", connectionId: mailbox.id, query: "is:unread" },
        enabled: false,
        mail: { mode: "auto", allowSenders: ["trusted@example.com"], dailyLimit: 2 },
      };
    await expect(service.save("alice", bot.id, auto)).rejects.toMatchObject({ code: "autoReplyConfirmationRequired" });
    const accepted = await service.save("alice", bot.id, { ...auto, confirmAutoReply: true });
    expect((await service.row("alice", bot.id, auto.id)).data.autoConsent?.owner).toBe("alice");
    await expect(
      service.save("alice", bot.id, {
        ...auto,
        revision: accepted.revision,
        instructions: "Different reply instructions",
      }),
    ).rejects.toMatchObject({ code: "autoReplyConfirmationRequired" });
    await expect(
      service.save("bob", store.createBot("bob", { code: "bob-mail", name: "Bob" }).id, {
        ...auto,
        id: randomUUID(),
        confirmAutoReply: true,
      }),
    ).rejects.toMatchObject({ code: "connectionNotFound" });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("feed HTTP support retains DNS pinning and rejects loopback sources before a network request", async () => {
  await expect(
    botRequest("http://127.0.0.1/feed", {
      method: "GET",
      allowHttp: true,
      maxBytes: 1024,
      signal: AbortSignal.timeout(2000),
    }),
  ).rejects.toMatchObject({ code: "targetDenied" });
});
