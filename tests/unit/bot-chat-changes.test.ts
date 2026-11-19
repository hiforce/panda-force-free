import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { BotStore } from "../../src/server/bots/store.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { BotChatLease } from "../../src/server/bots/workspace/chat-lease.js";
import { chatWrite, chatMessageId, messageWrite } from "../../src/server/bots/workspace/chat-records.js";
import type { BotChatMessage } from "../../src/shared/bots/workspace.js";

test("chat change cursors skip unchanged history and ignore heartbeat churn while preserving reply and clear updates", async () => {
  const store = new BotStore(":memory:"),
    service = new BotChatService(store);
  try {
    const bot = store.createBot("alice", { code: "delta-chat", name: "Delta Panda" }),
      initial = await service.changes("alice", bot.id);
    expect("unchanged" in initial).toBe(false);
    expect(await service.changes("alice", bot.id, initial.cursor)).toEqual({
      unchanged: true,
      cursor: initial.cursor!,
    });
    await service.send("alice", bot.id, { requestId: randomUUID(), generation: 1, text: "A new question" });
    const queued = await service.changes("alice", bot.id, initial.cursor);
    if ("unchanged" in queued) throw new Error("New input was not returned");
    expect(queued.messages).toHaveLength(2);
    expect(queued.busy).toBe(true);
    const state = await service.state("alice", bot.id),
      leaseId = randomUUID();
    await store.workspace.batch("alice", {
      checks: [{ kind: state.kind, id: state.id, version: state.version }],
      puts: [
        chatWrite(
          bot.id,
          { ...state.data, pending: { ...state.data.pending!, lease: leaseId } },
          "running",
          Date.now() + 30000,
        ),
      ],
    });
    const lease = new BotChatLease(store.workspace, "alice", bot.id, 1, leaseId);
    await lease.touch();
    expect(await service.changes("alice", bot.id, queued.cursor)).toEqual({ unchanged: true, cursor: queued.cursor! });
    await lease.message("Working on the reply");
    const partial = await service.changes("alice", bot.id, queued.cursor);
    if ("unchanged" in partial) throw new Error("Reply delta was not returned");
    expect(partial.messages).toHaveLength(1);
    expect(partial.messages[0]!.text).toBe("Working on the reply");
    await lease.finish("The complete answer");
    const complete = await service.changes("alice", bot.id, partial.cursor);
    if ("unchanged" in complete) throw new Error("Final reply was not returned");
    expect(complete.busy).toBe(false);
    expect(complete.messages[0]!.text).toBe("The complete answer");
    expect(await service.changes("alice", bot.id, complete.cursor)).toEqual({
      unchanged: true,
      cursor: complete.cursor!,
    });
    await service.clear("alice", bot.id, { requestId: randomUUID(), generation: 1 });
    const clear = await service.changes("alice", bot.id, complete.cursor);
    expect(clear).toMatchObject({ generation: 2, messages: [], replace: true });
    await expect(service.changes("bob", bot.id, initial.cursor)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    store.close();
  }
});
test("long-history polling returns the previous tail and new messages rather than transferring a whole page on each update", async () => {
  const store = new BotStore(":memory:"),
    service = new BotChatService(store);
  try {
    const bot = store.createBot("alice", { code: "history-delta", name: "History" }),
      state = await service.state("alice", bot.id);
    for (let start = 1; start <= 200; start += 100) {
      const messages: BotChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
        id: chatMessageId(bot.id, 1, start + index),
        generation: 1,
        sequence: start + index,
        role: (start + index) % 2 ? "user" : "assistant",
        text: "Retained long message ".repeat(500),
        createdAt: start + index,
        status: "complete",
      }));
      await store.workspace.batch("alice", {
        checks: messages.map((m) => ({ kind: "chat-message" as const, id: m.id, version: null })),
        puts: messages.map((m) => messageWrite(bot.id, m)),
      });
    }
    await store.workspace.batch("alice", {
      checks: [{ kind: state.kind, id: state.id, version: state.version }],
      puts: [chatWrite(bot.id, { ...state.data, sequence: 200 })],
    });
    const first = await service.changes("alice", bot.id);
    if ("unchanged" in first) throw new Error("Initial page missing");
    expect(first.messages).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(JSON.stringify(await service.changes("alice", bot.id, first.cursor)).length).toBeLessThan(100);
    await service.send("alice", bot.id, { requestId: randomUUID(), generation: 1, text: "Next question" });
    const delta = await service.changes("alice", bot.id, first.cursor);
    if ("unchanged" in delta) throw new Error("Delta missing");
    expect(delta.messages.map((m) => m.sequence)).toEqual([200, 201, 202]);
    expect(delta.replace).toBeUndefined();
  } finally {
    store.close();
  }
});
