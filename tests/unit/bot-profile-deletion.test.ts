import { test, expect } from "bun:test";
import { BotStore } from "../../src/server/bots/store.js";

test("assistant deletion removes private records and grants without affecting shared connections or other assistants", async () => {
  const s = new BotStore(":memory:");
  try {
    const a = s.createBot("alice", { code: "first", name: "First" }),
      b = s.createBot("alice", { code: "other", name: "Other" });
    const key = s.issue("alice", { name: "Shared", botIds: [a.id, b.id], days: 1 }),
      single = s.issue("alice", { name: "Only first", botIds: [a.id], days: 1 });
    const task = s.submit(
      a,
      { externalTaskId: "product", instructions: "Inspect", input: { text: "Details", images: [] } },
      "task-instance",
    ).task;
    s.db.query("UPDATE bot_tasks SET status='completed' WHERE id=?").run(task.id);
    s.setSession("alice", a.id, "owned-native-session");
    for (const row of [
      { kind: "chat" as const, id: "chat", botId: a.id },
      { kind: "connection" as const, id: "shared", botId: "connections" },
    ])
      expect(
        await s.workspace.batch("alice", {
          checks: [{ kind: row.kind, id: row.id, version: null }],
          puts: [{ ...row, state: "idle", dueAt: null, expiresAt: null, data: {} }],
        }),
      ).toBe(true);
    expect(() => s.deleteBot("bob", a.id)).toThrow("notFound");
    expect(s.deleteBot("alice", a.id)).toEqual({ ok: true });
    expect(() => s.bot("alice", a.id)).toThrow("notFound");
    expect(s.bots("alice").map((b) => b.id)).toEqual([b.id]);
    expect(() => s.task("alice", task.id)).toThrow("notFound");
    expect(s.db.query("SELECT COUNT(*) n FROM bot_events WHERE taskId=?").get(task.id)).toEqual({ n: 0 });
    expect(await s.workspace.get("alice", { kind: "chat", id: "chat" })).toBeNull();
    expect(await s.workspace.get("alice", { kind: "connection", id: "shared" })).not.toBeNull();
    expect(s.authenticate(key.secret).botIds).toEqual([b.id]);
    expect(() => s.authenticate(single.secret)).toThrow("unauthorized");
    expect(s.hasSession("owned-native-session")).toBe(true);
    expect(() => s.saveBot(a)).toThrow("notFound");
    expect(
      await s.workspace.batch("alice", {
        checks: [{ kind: "chat", id: "late", version: null }],
        puts: [{ kind: "chat", id: "late", botId: a.id, state: "queued", dueAt: 1, expiresAt: null, data: {} }],
      }),
    ).toBe(false);
    const replacement = s.createBot("alice", { code: "first", name: "Replacement" });
    expect(replacement.id).not.toBe(a.id);
    expect(s.authenticate(key.secret).botIds).not.toContain(replacement.id);
  } finally {
    s.close();
  }
});

test("busy assistant deletion rolls back completely", async () => {
  for (const status of ["queued", "running", "callback_unknown"]) {
    const s = new BotStore(":memory:");
    try {
      const bot = s.createBot("alice", { code: "busy", name: "Busy" });
      const task = s.submit(
        bot,
        { externalTaskId: "scope", instructions: "Inspect", input: { text: "Evidence", images: [] } },
        "instance",
      ).task;
      s.db.query("UPDATE bot_tasks SET status=? WHERE id=?").run(status, task.id);
      expect(() => s.deleteBot("alice", bot.id)).toThrow("botBusy");
      expect(s.bots("alice")).toHaveLength(1);
    } finally {
      s.close();
    }
  }
  for (const [kind, state] of [
    ["chat", "running"],
    ["integration", "enabled"],
    ["run", "delivering"],
    ["delivery", "unknown"],
    ["cleanup", "pending"],
  ] as const) {
    const s = new BotStore(":memory:");
    try {
      const bot = s.createBot("alice", { code: "busy", name: "Busy" });
      await s.workspace.batch("alice", {
        checks: [{ kind, id: "busy", version: null }],
        puts: [{ kind, id: "busy", botId: bot.id, state, dueAt: null, expiresAt: null, data: {} }],
      });
      expect(() => s.deleteBot("alice", bot.id)).toThrow("botBusy");
      expect(await s.workspace.get("alice", { kind, id: "busy" })).not.toBeNull();
    } finally {
      s.close();
    }
  }
});
