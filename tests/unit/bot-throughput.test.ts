import { test, expect } from "bun:test";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("2000 synthetic tasks drain with bounded admission, four workers, per-Bot serialization and bounded sessions", async () => {
  const store = new BotStore(":memory:"),
    root = await mkdtemp(join(tmpdir(), "bot-throughput-")),
    active = new Set<string>(),
    sessions = new Set<string>();
  let peak = 0,
    executions = 0,
    networks = 0,
    sessionCount = 0;
  const worker = new BotWorker(
    store,
    (bot) => ({
      id: "synthetic-capacity",
      async run(input, callbacks) {
        expect(active.has(bot.id)).toBe(false);
        active.add(bot.id);
        peak = Math.max(peak, active.size);
        const sessionId = input.sessionId ?? "internal-capacity-" + ++sessionCount,
          runId = "run-" + ++executions;
        sessions.add(sessionId);
        try {
          await callbacks.session?.(sessionId);
          await callbacks.started({ sessionId, runId });
          await Bun.sleep(1);
          await callbacks.call({
            sessionId,
            runId,
            callId: "decision",
            name: "panda_bot_decide",
            arguments: {
              taskId: JSON.parse(input.prompt).taskId,
              decision: "complete",
              reason: "Synthetic fixture decision",
            },
          });
          return { sessionId, runId, status: "completed" };
        } finally {
          active.delete(bot.id);
        }
      },
    }),
    root,
    async () => {
      networks++;
      throw new Error("No network allowed in capacity fixtures");
    },
  );
  try {
    const bots = Array.from({ length: 5 }, (_, i) =>
      store.createBot("capacity", { code: "capacity-" + i, name: "Capacity " + i }),
    );
    worker.start();
    let accepted = 0,
      rejected = 0;
    const deadline = performance.now() + 25000;
    while (accepted < 2000) {
      const bot = bots[accepted % bots.length]!,
        input = {
          externalTaskId: "capacity-" + accepted,
          instructions: "Synthetic test",
          input: { text: "Synthetic record " + accepted, images: [] },
        };
      try {
        store.submit(bot, input, "key-" + accepted);
        if (accepted % 73 === 0) expect(store.submit(bot, input, "key-" + accepted).duplicate).toBe(true);
        accepted++;
        worker.tick();
      } catch (error) {
        if ((error as { code?: string }).code !== "queueFull") throw error;
        rejected++;
      }
      if (accepted % 100 === 0 || rejected) await Bun.sleep(1);
      if (performance.now() > deadline) throw new Error("Synthetic queue did not drain within its fixture budget");
    }
    while (store.queue("capacity").counts.finished !== 2000) {
      worker.tick();
      await Bun.sleep(5);
      if (performance.now() > deadline) throw new Error("Synthetic queue did not finish");
    }
    expect(executions).toBe(2000);
    expect(peak).toBe(4);
    expect(networks).toBe(0);
    expect(store.queue("capacity").total).toBe(2000);
    expect(store.queue("capacity").tasks).toHaveLength(50);
    expect(sessions.size).toBe(20);
    for (const id of sessions) expect(store.hasSession(id)).toBe(true);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
