import { createHash } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { BotChatSnapshot, BotChatMessage, BotChatRead } from "../../../shared/bots/workspace.js";
import type { BotRepository } from "../repository.js";
import {
  chatPrefix,
  chatMessageId,
  chatReceiptPrefix,
  chatWrite,
  messageWrite,
  type BotChatState,
  type BotChatReceipt,
} from "./chat-records.js";
import type { BotWorkspaceRecord, BotWorkspaceWrite } from "./storage.js";

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const requestId = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new BotError("invalidInput");
  return value;
};
const generation = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new BotError("invalidInput");
  return Number(value);
};
const check = (row: BotWorkspaceRecord) => ({ kind: row.kind, id: row.id, version: row.version });

/** One conversation per owner/Bot. User chat never resumes a Bot task's engine session. */
export class BotChatService {
  constructor(readonly store: BotRepository) {}
  async state(owner: string, botId: string) {
    if ((await this.store.bot(owner, botId)).id !== botId) throw new BotError("notFound", 404);
    for (let retry = 0; retry < 8; retry++) {
      const row = await this.store.workspace.get<BotChatState>(owner, { kind: "chat", id: botId });
      if (row) return row;
      const state: BotChatState = { generation: 1, sequence: 0, sessionId: null, updatedAt: Date.now(), pending: null };
      await this.store.workspace.batch(owner, {
        checks: [{ kind: "chat", id: botId, version: null }],
        puts: [chatWrite(botId, state)],
      });
    }
    throw new BotError("unavailable", 503);
  }
  async snapshot(owner: string, botId: string, before?: number, attempt = 0): Promise<BotChatSnapshot> {
    if (attempt > 3) throw new BotError("conflict", 409);
    const current = await this.state(owner, botId),
      rows = await this.store.workspace.list<BotChatMessage>(owner, "chat-message", {
        botId,
        prefix: chatPrefix(botId, current.data.generation),
        limit: 101,
        descending: true,
        ...(before === undefined ? {} : { before: chatMessageId(botId, current.data.generation, before) }),
      }),
      cleanup = await this.store.workspace.list(owner, "cleanup", { botId, limit: 1000 });
    if ((await this.state(owner, botId)).data.generation !== current.data.generation)
      return this.snapshot(owner, botId, before, attempt + 1);
    return {
      generation: current.data.generation,
      messages: rows
        .slice(0, 100)
        .reverse()
        .map((r) => r.data),
      hasMore: rows.length > 100,
      busy: current.data.pending !== null,
      cleanup: cleanup.some((r) => r.state === "blocked") ? "blocked" : cleanup.length ? "pending" : "ready",
    };
  }
  /** Idle polls read no history bodies; active polls return only the last reply and newly appended messages. */
  async changes(owner: string, botId: string, since?: string, before?: number, attempt = 0): Promise<BotChatRead> {
    if (attempt > 3) throw new BotError("conflict", 409);
    const current = await this.state(owner, botId),
      cleanupRows = await this.store.workspace.list(owner, "cleanup", { botId, limit: 1000 }),
      cleanup: BotChatSnapshot["cleanup"] = cleanupRows.some((r) => r.state === "blocked")
        ? "blocked"
        : cleanupRows.length
          ? "pending"
          : "ready",
      message = current.data.pending
        ? await this.store.workspace.get(owner, { kind: "chat-message", id: current.data.pending.assistantId })
        : null,
      cursor = [
        current.data.generation,
        current.data.sequence,
        message?.version ?? 0,
        current.data.pending ? 1 : 0,
        cleanup,
      ].join(":"),
      prior = /^(\d+):(\d+):\d+:[01]:(?:ready|pending|blocked)$/.exec(since ?? "");
    if (before === undefined && since === cursor) return { unchanged: true, cursor };
    const oldSequence = prior ? Number(prior[2]) : -1,
      delta =
        before === undefined &&
        prior &&
        Number(prior[1]) === current.data.generation &&
        oldSequence <= current.data.sequence &&
        current.data.sequence - oldSequence <= 98;
    if (!delta)
      return {
        ...(await this.snapshot(owner, botId, before)),
        cursor,
        ...(before === undefined && since ? { replace: true } : {}),
      };
    const rows = await this.store.workspace.list<BotChatMessage>(owner, "chat-message", {
      botId,
      prefix: chatPrefix(botId, current.data.generation),
      after: chatMessageId(botId, current.data.generation, Math.max(0, oldSequence - 1)),
      limit: 101,
    });
    if ((await this.state(owner, botId)).data.generation !== current.data.generation)
      return this.changes(owner, botId, since, before, attempt + 1);
    return {
      generation: current.data.generation,
      messages: rows.map((r) => r.data),
      hasMore: false,
      busy: current.data.pending !== null,
      cleanup,
      cursor,
    };
  }
  async send(owner: string, botId: string, value: unknown) {
    if (!isRecord(value) || Object.keys(value).some((k) => !["requestId", "generation", "text"].includes(k)))
      throw new BotError("invalidInput");
    const id = requestId(value.requestId),
      expectedGeneration = generation(value.generation);
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 32000)
      throw new BotError("invalidInput");
    const text = value.text.trim(),
      bot = await this.store.bot(owner, botId),
      receiptKey = { kind: "chat-receipt" as const, id: chatReceiptPrefix(botId, expectedGeneration) + id };
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.state(owner, botId),
        prior = await this.store.workspace.get<BotChatReceipt>(owner, receiptKey);
      if (current.data.generation !== expectedGeneration) throw new BotError("staleConversation", 409);
      if (prior) {
        if (prior.data.generation !== expectedGeneration || prior.data.fingerprint !== fingerprint(text))
          throw new BotError("idempotencyConflict", 409);
        return { generation: expectedGeneration, duplicate: true };
      }
      if (current.data.pending) throw new BotError("chatBusy", 409);
      const now = Date.now(),
        userId = chatMessageId(botId, expectedGeneration, current.data.sequence + 1),
        assistantId = chatMessageId(botId, expectedGeneration, current.data.sequence + 2),
        state: BotChatState = {
          ...current.data,
          sequence: current.data.sequence + 2,
          updatedAt: now,
          pending: {
            requestId: id,
            userId,
            assistantId,
            lease: null,
            bot: { name: bot.name, model: bot.model, instructions: bot.instructions, persona: bot.persona },
          },
        },
        messages: BotChatMessage[] = [
          {
            id: userId,
            generation: expectedGeneration,
            sequence: state.sequence - 1,
            role: "user",
            text,
            createdAt: now,
            status: "complete",
            requestId: id,
          },
          {
            id: assistantId,
            generation: expectedGeneration,
            sequence: state.sequence,
            role: "assistant",
            text: "",
            createdAt: now,
            status: "queued",
          },
        ];
      if (
        await this.store.workspace.batch(owner, {
          checks: [
            check(current),
            { ...receiptKey, version: null },
            ...messages.map((m) => ({ kind: "chat-message" as const, id: m.id, version: null })),
          ],
          puts: [
            chatWrite(botId, state, "queued", now),
            ...messages.map((m) => messageWrite(botId, m)),
            {
              ...receiptKey,
              botId,
              state: "accepted",
              dueAt: null,
              expiresAt: null,
              data: {
                action: "send",
                generation: expectedGeneration,
                fingerprint: fingerprint(text),
                userId,
              } satisfies BotChatReceipt,
            },
          ],
        })
      )
        return { generation: expectedGeneration, duplicate: false };
    }
    throw new BotError("conflict", 409);
  }
  async clear(owner: string, botId: string, value: unknown) {
    if (!isRecord(value) || Object.keys(value).some((k) => !["requestId", "generation"].includes(k)))
      throw new BotError("invalidInput");
    const id = requestId(value.requestId),
      expectedGeneration = generation(value.generation),
      receiptKey = { kind: "chat-receipt" as const, id: botId + ":clear:" + id };
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.state(owner, botId),
        prior = await this.store.workspace.get<BotChatReceipt>(owner, receiptKey);
      if (prior) {
        if (prior.data.generation !== expectedGeneration + 1) throw new BotError("idempotencyConflict", 409);
        return { generation: prior.data.generation, duplicate: true };
      }
      if (current.data.generation !== expectedGeneration) throw new BotError("staleConversation", 409);
      const next: BotChatState = {
          generation: expectedGeneration + 1,
          sequence: 0,
          sessionId: null,
          updatedAt: Date.now(),
          pending: null,
        },
        cleanup: BotWorkspaceWrite[] = [
          {
            kind: "cleanup",
            id: botId + ":records:" + expectedGeneration,
            botId,
            state: "pending",
            dueAt: Date.now(),
            expiresAt: null,
            data: { type: "records", throughGeneration: expectedGeneration },
          },
        ];
      if (current.data.sessionId)
        cleanup.push({
          kind: "cleanup",
          id: botId + ":engine:" + current.data.sessionId,
          botId,
          state: "pending",
          dueAt: Date.now(),
          expiresAt: null,
          data: { type: "engine", sessionId: current.data.sessionId, model: current.data.pending?.bot.model ?? "" },
        });
      if (
        await this.store.workspace.batch(owner, {
          checks: [
            check(current),
            { ...receiptKey, version: null },
            ...cleanup.map((c) => ({ kind: c.kind, id: c.id, version: null })),
          ],
          puts: [
            chatWrite(botId, next),
            ...cleanup,
            {
              ...receiptKey,
              botId,
              state: "accepted",
              dueAt: null,
              expiresAt: null,
              data: { action: "clear", generation: next.generation } satisfies BotChatReceipt,
            },
          ],
        })
      )
        return { generation: next.generation, duplicate: false };
    }
    throw new BotError("conflict", 409);
  }
}
