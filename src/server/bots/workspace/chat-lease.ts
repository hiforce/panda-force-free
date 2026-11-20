import type { BotChatFailure, BotChatMessage } from "../../../shared/bots/workspace.js";
import type { BotWorkspaceRecord, BotWorkspaceStorage, BotWorkspaceWrite } from "./storage.js";
import { chatWrite, messageWrite, unchangedWrite, type BotChatState } from "./chat-records.js";

export async function queueChatEngineCleanup(
  store: BotWorkspaceStorage,
  owner: string,
  botId: string,
  sessionId: string,
  model: string,
) {
  const key = { kind: "cleanup" as const, id: botId + ":engine:" + sessionId };
  await store.batch(owner, {
    checks: [{ ...key, version: null }],
    puts: [
      {
        ...key,
        botId,
        state: "pending",
        dueAt: Date.now(),
        expiresAt: null,
        data: { type: "engine", sessionId, model },
      },
    ],
  });
}

/** Every callback checks both the generation and lease, including callbacks returning after clear or restart. */
export class BotChatLease {
  constructor(
    private store: BotWorkspaceStorage,
    readonly owner: string,
    readonly botId: string,
    readonly generation: number,
    readonly lease: string,
  ) {}
  async current() {
    const row = await this.store.get<BotChatState>(this.owner, { kind: "chat", id: this.botId });
    return row &&
      row.state === "running" &&
      row.data.generation === this.generation &&
      row.data.pending?.lease === this.lease &&
      (row.dueAt ?? 0) > Date.now()
      ? row
      : null;
  }
  async touch() {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.current();
      if (!current) return false;
      if (
        await this.store.batch(this.owner, {
          checks: [{ kind: "chat", id: this.botId, version: current.version }],
          puts: [unchangedWrite(current, current.data, { dueAt: Date.now() + 30000 })],
        })
      )
        return true;
    }
    return false;
  }
  async bind(sessionId: string, model: string, runId?: string, toolset?: BotChatState["toolset"]) {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.current();
      if (!current) {
        await queueChatEngineCleanup(this.store, this.owner, this.botId, sessionId, model);
        throw new Error("Bot conversation generation changed");
      }
      const cleanupKey =
          current.data.sessionId && current.data.sessionId !== sessionId
            ? { kind: "cleanup" as const, id: this.botId + ":engine:" + current.data.sessionId }
            : null,
        priorCleanup = cleanupKey ? await this.store.get(this.owner, cleanupKey) : null,
        state = {
          ...current.data,
          sessionId,
          ...(toolset ? { toolset } : {}),
          pending: { ...current.data.pending!, ...(runId ? { runId } : {}) },
        };
      if (
        await this.store.batch(this.owner, {
          checks: [
            { kind: "chat", id: this.botId, version: current.version },
            ...(cleanupKey ? [{ ...cleanupKey, version: priorCleanup?.version ?? null }] : []),
          ],
          puts: [
            unchangedWrite(current, state),
            ...(cleanupKey && !priorCleanup
              ? [
                  {
                    ...cleanupKey,
                    botId: this.botId,
                    state: "pending",
                    dueAt: Date.now(),
                    expiresAt: null,
                    data: { type: "engine", sessionId: current.data.sessionId, model },
                  },
                ]
              : []),
          ],
        })
      )
        return;
    }
    throw new Error("Bot conversation changed");
  }
  async message(text: string) {
    for (let retry = 0; retry < 4; retry++) {
      const current = await this.current();
      if (!current) return;
      const message = await this.store.get<BotChatMessage>(this.owner, {
        kind: "chat-message",
        id: current.data.pending!.assistantId,
      });
      if (!message) return;
      if (
        await this.store.batch(this.owner, {
          checks: [
            { kind: "chat", id: this.botId, version: current.version },
            { kind: message.kind, id: message.id, version: message.version },
          ],
          puts: [messageWrite(this.botId, { ...message.data, text: text.slice(0, 64000), status: "running" })],
        })
      )
        return;
    }
  }
  async finish(text: string, failure?: BotChatFailure) {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.current();
      if (!current) return;
      const message = await this.store.get<BotChatMessage>(this.owner, {
        kind: "chat-message",
        id: current.data.pending!.assistantId,
      });
      if (!message) return;
      const cleanupKey =
          current.data.sessionId && failure
            ? { kind: "cleanup" as const, id: this.botId + ":engine:" + current.data.sessionId }
            : null,
        priorCleanup = cleanupKey ? await this.store.get(this.owner, cleanupKey) : null,
        state: BotChatState = {
          ...current.data,
          sessionId: failure ? null : current.data.sessionId,
          pending: null,
          updatedAt: Date.now(),
        },
        puts: BotWorkspaceWrite[] = [
          chatWrite(this.botId, state),
          messageWrite(this.botId, {
            ...message.data,
            text: text.slice(0, 64000) || message.data.text,
            status: failure ? "error" : "complete",
            ...(failure ? { failure } : {}),
          }),
        ];
      if (cleanupKey && !priorCleanup)
        puts.push({
          ...cleanupKey,
          botId: this.botId,
          state: "pending",
          dueAt: Date.now(),
          expiresAt: null,
          data: { type: "engine", sessionId: current.data.sessionId, model: current.data.pending!.bot.model },
        });
      if (
        await this.store.batch(this.owner, {
          checks: [
            { kind: "chat", id: this.botId, version: current.version },
            { kind: message.kind, id: message.id, version: message.version },
            ...(cleanupKey ? [{ ...cleanupKey, version: priorCleanup?.version ?? null }] : []),
          ],
          puts,
        })
      )
        return;
    }
    throw new Error("Bot reply could not be saved");
  }
}

export async function recoverBotChat(store: BotWorkspaceStorage, current: BotWorkspaceRecord<BotChatState>) {
  if (!current.data.pending || current.state !== "running" || (current.dueAt ?? Infinity) > Date.now()) return;
  const message = await store.get<BotChatMessage>(current.owner, {
    kind: "chat-message",
    id: current.data.pending.assistantId,
  });
  if (!message) return;
  const cleanupKey = current.data.sessionId
      ? { kind: "cleanup" as const, id: current.botId + ":engine:" + current.data.sessionId }
      : null,
    prior = cleanupKey ? await store.get(current.owner, cleanupKey) : null;
  if (
    await store.batch(current.owner, {
      checks: [
        { kind: current.kind, id: current.id, version: current.version },
        { kind: message.kind, id: message.id, version: message.version },
        ...(cleanupKey ? [{ ...cleanupKey, version: prior?.version ?? null }] : []),
      ],
      puts: [
        chatWrite(current.botId, { ...current.data, sessionId: null, pending: null, updatedAt: Date.now() }),
        messageWrite(current.botId, { ...message.data, status: "error", failure: "interrupted" }),
        ...(cleanupKey && !prior
          ? [
              {
                ...cleanupKey,
                botId: current.botId,
                state: "pending",
                dueAt: Date.now(),
                expiresAt: null,
                data: { type: "engine", sessionId: current.data.sessionId, model: current.data.pending.bot.model },
              },
            ]
          : []),
      ],
    })
  )
    return;
}
