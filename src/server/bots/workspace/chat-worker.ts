import { randomUUID } from "node:crypto";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import type { BotConfig } from "../../../shared/bots/contracts.js";
import type { BotChatMessage } from "../../../shared/bots/workspace.js";
import type { BotRepository } from "../repository.js";
import { executeBotChat } from "./chat-execution.js";
import { recoverBotChat } from "./chat-lease.js";
import {
  chatPrefix,
  chatReceiptPrefix,
  messageWrite,
  unchangedWrite,
  type BotChatCleanup,
  type BotChatState,
} from "./chat-records.js";
import type { BotWorkspaceRecord } from "./storage.js";
import type { BotChatContextPort } from "./chat-context.js";

/** Durable chat claims and cleanup records survive process restarts; local aborts are an additional fast path. */
export class BotChatWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private ticking: Promise<void> | null = null;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private cleaning = new Map<string, Promise<void>>();
  constructor(
    private store: BotRepository,
    private engine: (bot: BotConfig) => ApplicationToolEngine,
    private directory: (botId: string) => string,
    private context?: BotChatContextPort,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }
  interrupt(owner: string, botId: string) {
    this.active.get(JSON.stringify([owner, botId]))?.controller.abort();
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.drain()
      .catch(() => {})
      .finally(() => {
        if (this.ticking === work) this.ticking = null;
      });
    this.ticking = work;
    return work;
  }
  private async drain() {
    for (const expired of await this.store.workspace.scan<BotChatState>("chat", {
      state: "running",
      dueBefore: Date.now(),
      limit: 20,
    }))
      await recoverBotChat(this.store.workspace, expired);
    const queued = await this.store.workspace.scan<BotChatState>("chat", {
      state: "queued",
      dueBefore: Date.now(),
      limit: 20,
    });
    for (const row of queued) {
      if (this.stopped || this.active.size >= 2) break;
      const key = JSON.stringify([row.owner, row.botId]);
      if (this.active.has(key) || !row.data.pending) continue;
      const state: BotChatState = { ...row.data, pending: { ...row.data.pending, lease: randomUUID() } },
        dueAt = Date.now() + 30000,
        message = await this.store.workspace.get<BotChatMessage>(row.owner, {
          kind: "chat-message",
          id: state.pending!.assistantId,
        });
      if (!message) continue;
      if (
        !(await this.store.workspace.batch(row.owner, {
          checks: [
            { kind: row.kind, id: row.id, version: row.version },
            { kind: message.kind, id: message.id, version: message.version },
          ],
          puts: [
            unchangedWrite(row, state, { state: "running", dueAt }),
            messageWrite(row.botId, { ...message.data, status: "running" }),
          ],
        }))
      )
        continue;
      const controller = new AbortController(),
        promise = executeBotChat(
          this.store,
          { ...row, version: row.version + 1, state: "running", dueAt, data: state },
          controller,
          this.engine,
          this.directory,
          this.context,
        )
          .catch(() => {})
          .finally(() => {
            this.active.delete(key);
            void this.tick();
          });
      this.active.set(key, { controller, promise });
    }
    for (const row of await this.store.workspace.scan<BotChatCleanup>("cleanup", {
      dueBefore: Date.now(),
      limit: 20,
    })) {
      if (this.stopped || this.cleaning.size >= 2) break;
      const key = JSON.stringify([row.owner, row.id]);
      if (this.cleaning.has(key) || row.state === "blocked") continue;
      const state = { ...row.data, lease: randomUUID() };
      if (
        !(await this.store.workspace.batch(row.owner, {
          checks: [{ kind: row.kind, id: row.id, version: row.version }],
          puts: [unchangedWrite(row, state, { state: "running", dueAt: Date.now() + 30000 })],
        }))
      )
        continue;
      const promise = this.cleanup({ ...row, version: row.version + 1, state: "running", data: state })
        .catch(() => {})
        .finally(() => {
          this.cleaning.delete(key);
          void this.tick();
        });
      this.cleaning.set(key, promise);
    }
  }
  private async cleanup(row: BotWorkspaceRecord<BotChatCleanup>) {
    try {
      if (row.data.type === "records") {
        const messages = await this.store.workspace.list(row.owner, "chat-message", {
            botId: row.botId,
            prefix: row.botId + ":",
            before: chatPrefix(row.botId, row.data.throughGeneration + 1),
            limit: 80,
          }),
          receipts = await this.store.workspace.list(row.owner, "chat-receipt", {
            botId: row.botId,
            prefix: row.botId + ":send:",
            before: chatReceiptPrefix(row.botId, row.data.throughGeneration + 1),
            limit: 80,
          }),
          rows = [...messages, ...receipts];
        await this.store.workspace.batch(row.owner, {
          checks: [
            { kind: row.kind, id: row.id, version: row.version },
            ...rows.map((r) => ({ kind: r.kind, id: r.id, version: r.version })),
          ],
          removes: rows.length ? rows.map((r) => ({ kind: r.kind, id: r.id })) : [{ kind: row.kind, id: row.id }],
          ...(rows.length ? { puts: [unchangedWrite(row, row.data, { state: "pending", dueAt: Date.now() })] } : {}),
        });
        return;
      }
      const bot = await this.store.bot(row.owner, row.botId),
        engine = this.engine({ ...bot, model: row.data.model });
      if (!engine.forget) {
        await this.store.workspace.batch(row.owner, {
          checks: [{ kind: row.kind, id: row.id, version: row.version }],
          puts: [
            unchangedWrite(
              row,
              { ...row.data, failure: "providerDeletionUnavailable" as const },
              { state: "blocked", dueAt: null },
            ),
          ],
        });
        return;
      }
      if (bot.sessionId === row.data.sessionId) throw new Error("Task session cannot be deleted by human chat cleanup");
      await engine.forget(row.data.sessionId);
      await this.store.workspace.batch(row.owner, {
        checks: [{ kind: row.kind, id: row.id, version: row.version }],
        removes: [{ kind: row.kind, id: row.id }],
      });
    } catch {
      const attempts = (row.data.attempts ?? 0) + 1;
      await this.store.workspace.batch(row.owner, {
        checks: [{ kind: row.kind, id: row.id, version: row.version }],
        puts: [
          unchangedWrite(
            row,
            { ...row.data, attempts, failure: "cleanupUnavailable" as const },
            {
              state: attempts >= 8 ? "blocked" : "pending",
              dueAt: attempts >= 8 ? null : Date.now() + Math.min(300000, 1000 * 2 ** attempts),
            },
          ),
        ],
      });
    }
  }
  async retryCleanup(owner: string, botId: string) {
    await this.store.bot(owner, botId);
    for (const row of await this.store.workspace.list<BotChatCleanup>(owner, "cleanup", {
      botId,
      state: "blocked",
      limit: 1000,
    }))
      await this.store.workspace.batch(owner, {
        checks: [{ kind: row.kind, id: row.id, version: row.version }],
        puts: [unchangedWrite(row, { ...row.data, attempts: 0 }, { state: "pending", dueAt: Date.now() })],
      });
    await this.tick();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const work of this.active.values()) work.controller.abort();
    await this.ticking;
    await Promise.allSettled([...this.active.values()].map((work) => work.promise).concat([...this.cleaning.values()]));
  }
}
