import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { BotChatWorker } from "../../src/server/bots/workspace/chat-worker.js";
import { recoverBotChat } from "../../src/server/bots/workspace/chat-lease.js";
import type { BotChatState } from "../../src/server/bots/workspace/chat-records.js";

async function waitFor(check: () => Promise<boolean>, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Bot chat fixture timed out");
}

test("normal completed Bot messages need no tool call while commentary and unsuccessful runs remain errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-normal-reply-"));
  try {
    for (const [status, phase, succeeds] of [
      ["completed", "final_answer", true],
      ["completed", undefined, true],
      ["completed", "commentary", false],
      ["failed", "final_answer", false],
      ["interrupted", "final_answer", false],
    ] as const) {
      const store = new BotStore(":memory:"),
        service = new BotChatService(store),
        worker = new BotChatWorker(
          store,
          () => ({
            id: "normal-reply",
            async run(_input, callbacks) {
              const scope = { sessionId: "plain-chat", runId: "plain-reply" };
              await callbacks.started(scope);
              await callbacks.event?.({ kind: "message", id: "reply", text: "Partial", complete: false });
              await callbacks.event?.({
                kind: "message",
                id: "reply",
                text: "A complete, reusable **Markdown reply**.",
                complete: true,
                ...(phase ? { phase } : {}),
              });
              return { ...scope, status };
            },
          }),
          (botId) => join(root, botId),
        );
      try {
        const bot = store.createBot("alice", { name: "Normal conversation", code: "plain-chat" });
        await service.send("alice", bot.id, { requestId: randomUUID(), generation: 1, text: "Hello" });
        await worker.tick();
        await waitFor(async () => !(await service.snapshot("alice", bot.id)).busy);
        const snapshot = await service.snapshot("alice", bot.id),
          reply = snapshot.messages[1]!;
        expect(reply.text).toBe("A complete, reusable **Markdown reply**.");
        expect(reply.status).toBe(succeeds ? "complete" : "error");
        expect(reply.failure).toBe(succeeds ? undefined : status === "interrupted" ? "interrupted" : "failed");
        expect(snapshot.messages).toHaveLength(2);
      } finally {
        await worker.close();
        store.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing a running human conversation interrupts and removes it while late output cannot restore it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-human-chat-")),
    store = new BotStore(":memory:"),
    service = new BotChatService(store),
    prompts: string[] = [],
    deleted: string[] = [];
  let release!: () => void,
    firstSignal: AbortSignal | undefined,
    lateRejected = false,
    runs = 0;
  const held = new Promise<void>((resolve) => (release = resolve)),
    worker = new BotChatWorker(
      store,
      () => ({
        id: "fixture",
        async forget(sessionId) {
          deleted.push(sessionId);
        },
        async run(input, callbacks) {
          const run = ++runs,
            scope = { sessionId: "human-session-" + run, runId: "human-run-" + run };
          expect(input.tools.map((t) => t.name)).toEqual(["panda_bot_chat_reply"]);
          expect(input.sessionId).toBeUndefined();
          prompts.push(input.prompt);
          await callbacks.session?.(scope.sessionId);
          await callbacks.started(scope);
          if (run === 1) {
            firstSignal = callbacks.signal;
            await held;
          }
          try {
            await callbacks.call({
              ...scope,
              callId: "reply-" + run,
              name: "panda_bot_chat_reply",
              arguments: { text: "Reply " + run },
            });
          } catch {
            if (run === 1) lateRejected = true;
            else throw new Error("New generation reply rejected");
          }
          return { ...scope, status: "completed" };
        },
      }),
      (botId) => join(root, botId),
    );
  try {
    const bot = store.createBot("alice", {
      code: "independent-chat",
      name: "Independent",
      persona: { role: "Helper", traits: "Warm", voice: "Clear", motto: "Hello" },
    });
    store.setSession("alice", bot.id, "background-task-session");
    const task = store.submit(
      store.bot("alice", bot.id),
      { externalTaskId: "one", instructions: "Background", input: { text: "Background facts", images: [] } },
      "one",
    ).task;
    await service.send("alice", bot.id, {
      requestId: randomUUID(),
      generation: 1,
      text: "Original secret human message",
    });
    await worker.tick();
    await waitFor(async () => !!firstSignal);
    await service.clear("alice", bot.id, { requestId: randomUUID(), generation: 1 });
    worker.interrupt("alice", bot.id);
    await worker.tick();
    expect(firstSignal?.aborted).toBe(true);
    await service.send("alice", bot.id, { requestId: randomUUID(), generation: 2, text: "Fresh human message" });
    release();
    await waitFor(async () => {
      await worker.tick();
      const value = await service.snapshot("alice", bot.id);
      return (
        !value.busy &&
        value.messages.length === 2 &&
        value.messages[1]!.status === "complete" &&
        value.cleanup === "ready"
      );
    });
    const after = await service.snapshot("alice", bot.id);
    expect(after.messages.map((m) => m.text)).toEqual(["Fresh human message", "Reply 2"]);
    expect(lateRejected).toBe(true);
    expect(prompts[1]).not.toContain("Original secret");
    expect(prompts[1]).not.toContain("Background facts");
    expect(deleted).toEqual(["human-session-1"]);
    expect(JSON.stringify(await store.workspace.list("alice", "chat-message", { botId: bot.id }))).not.toContain(
      "Original secret",
    );
    expect(store.bot("alice", bot.id).sessionId).toBe("background-task-session");
    expect(store.bot("alice", bot.id).persona).toEqual(bot.persona);
    expect(store.task("alice", task.id).input.input.text).toBe("Background facts");
  } finally {
    release();
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired chat execution is not silently replayed and retains a durable owned-session cleanup job", async () => {
  const store = new BotStore(":memory:"),
    service = new BotChatService(store);
  try {
    const bot = store.createBot("alice", { code: "recover-chat", name: "Recover" });
    await service.send("alice", bot.id, { requestId: randomUUID(), generation: 1, text: "Keep my input" });
    const row = (await service.state("alice", bot.id))!,
      state: BotChatState = {
        ...row.data,
        sessionId: "old-human",
        pending: { ...row.data.pending!, lease: "expired" },
      };
    await store.workspace.batch("alice", {
      checks: [{ kind: row.kind, id: row.id, version: row.version }],
      puts: [{ ...row, state: "running", dueAt: 0, data: state }],
    });
    const expired = (await service.state("alice", bot.id))!;
    await recoverBotChat(store.workspace, expired);
    await recoverBotChat(store.workspace, expired);
    const snapshot = await service.snapshot("alice", bot.id);
    expect(snapshot.busy).toBe(false);
    expect(snapshot.messages[0]?.text).toBe("Keep my input");
    expect(snapshot.messages[1]?.failure).toBe("interrupted");
    expect((await service.state("alice", bot.id)).data.sessionId).toBeNull();
    const jobs = await store.workspace.list("alice", "cleanup", { botId: bot.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ type: "engine", sessionId: "old-human" });
  } finally {
    store.close();
  }
});
