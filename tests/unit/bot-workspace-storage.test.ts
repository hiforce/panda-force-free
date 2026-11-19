import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { BotStore } from "../../src/server/bots/store.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { chatMessageId, messageWrite } from "../../src/server/bots/workspace/chat-records.js";
import { botWorkspaceOverview } from "../../src/server/bots/workspace/overview.js";
import type { BotChatMessage } from "../../src/shared/bots/workspace.js";

test("workspace batches check all read versions before mutating any owner records", async () => {
  const store = new BotStore(":memory:"),
    key = { kind: "channel" as const, id: "channel-one" },
    botId = randomUUID();
  try {
    const put = { ...key, botId, state: "active", dueAt: null, expiresAt: null, data: { title: "Private" } };
    expect(await store.workspace.batch("alice", { checks: [{ ...key, version: null }], puts: [put] })).toBe(true);
    expect(await store.workspace.get("bob", key)).toBeNull();
    const results = await Promise.all(
      [1, 2].map((value) =>
        store.workspace.batch("alice", {
          checks: [{ ...key, version: 1 }],
          puts: [{ ...put, data: { value } }],
        }),
      ),
    );
    expect(results.sort()).toEqual([false, true]);
    expect((await store.workspace.get("alice", key))?.version).toBe(2);
    expect(
      await store.workspace.batch("alice", {
        checks: [
          { ...key, version: 2 },
          { kind: "channel", id: "missing", version: 1 },
        ],
        removes: [key],
      }),
    ).toBe(false);
    expect(await store.workspace.get("alice", key)).not.toBeNull();
    await expect(
      store.workspace.batch("alice", {
        checks: [{ ...key, version: 2 }],
        removes: [{ kind: "channel", id: "unguarded" }],
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    expect(await store.workspace.counts("alice", "channel")).toEqual({ [botId]: { active: 1 } });
    expect(await store.workspace.counts("bob", "channel")).toEqual({});
  } finally {
    store.close();
  }
});

test("one Bot chat coalesces concurrent submissions and fences clear/replay without changing tasks or persona", async () => {
  const store = new BotStore(":memory:"),
    service = new BotChatService(store);
  try {
    const bot = store.createBot("alice", {
        code: "human-panda",
        name: "Human Panda",
        persona: { role: "Researcher", traits: "Curious", voice: "Concise", motto: "Ask why" },
      }),
      task = store.submit(
        bot,
        { externalTaskId: "background", instructions: "Independent", input: { text: "Task facts", images: [] } },
        "background",
      ).task;
    expect(await service.snapshot("alice", bot.id)).toEqual({
      generation: 1,
      messages: [],
      busy: false,
      hasMore: false,
      cleanup: "ready",
    });
    await expect(service.snapshot("bob", bot.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(service.snapshot("alice", bot.code)).rejects.toMatchObject({ code: "notFound" });
    const request = { requestId: randomUUID(), generation: 1, text: "Private human conversation" },
      sent = await Promise.all(Array.from({ length: 10 }, () => service.send("alice", bot.id, request)));
    expect(sent.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await service.snapshot("alice", bot.id)).messages).toHaveLength(2);
    await expect(service.send("alice", bot.id, { ...request, text: "Changed payload" })).rejects.toMatchObject({
      code: "idempotencyConflict",
    });
    await expect(service.send("alice", bot.id, { ...request, requestId: randomUUID() })).rejects.toMatchObject({
      code: "chatBusy",
    });
    const clear = { requestId: randomUUID(), generation: 1 },
      first = await service.clear("alice", bot.id, clear);
    expect(first.generation).toBe(2);
    expect((await service.clear("alice", bot.id, clear)).duplicate).toBe(true);
    expect((await service.snapshot("alice", bot.id)).messages).toEqual([]);
    await expect(service.send("alice", bot.id, request)).rejects.toMatchObject({ code: "staleConversation" });
    await expect(service.clear("alice", bot.id, { requestId: randomUUID(), generation: 1 })).rejects.toMatchObject({
      code: "staleConversation",
    });
    await expect(service.clear("alice", bot.id, { ...clear, generation: 2 })).rejects.toMatchObject({
      code: "idempotencyConflict",
    });
    expect(store.bot("alice", bot.id)).toEqual(bot);
    expect(store.task("alice", task.id).input.input.text).toBe("Task facts");
  } finally {
    store.close();
  }
});

test("chat history pages through more than a thousand messages and Bot summaries are not limited to a queue page", async () => {
  const store = new BotStore(":memory:"),
    service = new BotChatService(store);
  try {
    const bot = store.createBot("alice", { code: "history-panda", name: "History Panda" });
    await service.state("alice", bot.id);
    for (let start = 1; start <= 1202; start += 100) {
      const messages: BotChatMessage[] = Array.from({ length: Math.min(100, 1203 - start) }, (_, index) => ({
        id: chatMessageId(bot.id, 1, start + index),
        generation: 1,
        sequence: start + index,
        role: "user",
        text: "Message " + (start + index),
        status: "complete",
        createdAt: start + index,
      }));
      expect(
        await store.workspace.batch("alice", {
          checks: messages.map((m) => ({ kind: "chat-message" as const, id: m.id, version: null })),
          puts: messages.map((m) => messageWrite(bot.id, m)),
        }),
      ).toBe(true);
    }
    let page = await service.snapshot("alice", bot.id),
      count = page.messages.length;
    expect(page.messages.at(-1)?.sequence).toBe(1202);
    while (page.hasMore) {
      const before = page.messages[0]!.sequence;
      page = await service.snapshot("alice", bot.id, before);
      expect(page.messages.every((m) => m.sequence < before)).toBe(true);
      count += page.messages.length;
    }
    expect(count).toBe(1202);
    for (let i = 0; i < 225; i++)
      store.submit(
        bot,
        { externalTaskId: "task-" + i, instructions: "Check", input: { text: "Facts", images: [] } },
        "task-" + i,
      );
    expect(store.tasks("alice")).toHaveLength(200);
    expect((await botWorkspaceOverview(store, "alice")).counts.queued).toBe(225);
    expect((await botWorkspaceOverview(store, "bob")).counts.bots).toBe(0);
  } finally {
    store.close();
  }
});
