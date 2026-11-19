import { createHash } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { BotIntegrations, botIntegrationCheck } from "./configuration.js";
import {
  botChannelView,
  botDeliveryIdentity,
  type BotChannelRecord,
  type BotIntegrationDelivery,
} from "./delivery-records.js";
import { botConnectionId } from "./connections.js";

export class BotIntegrationChannel {
  constructor(readonly integrations: BotIntegrations) {}
  async list(owner: string, botId: string, integrationId: string, before?: string) {
    const config = await this.integrations.row(owner, botId, integrationId),
      now = Date.now();
    const messages: ReturnType<typeof botChannelView>[] = [];
    let cursor = before;
    // Other integrations share the Bot channel. Advance through bounded pages without exposing their contents.
    for (let page = 0; page < 10; page++) {
      const rows = await this.integrations.store.workspace.list<BotChannelRecord>(owner, "channel-message", {
        botId,
        descending: true,
        liveAt: now,
        limit: 100,
        ...(cursor ? { before: cursor } : {}),
      });
      if (!rows.length) return { messages, next: null };
      for (const row of rows) {
        cursor = row.id;
        if (
          row.data.integrationId !== integrationId ||
          row.data.createdAt + config.data.config.retentionDays * 86400000 <= now
        )
          continue;
        messages.push(botChannelView(row.data));
        if (messages.length === 30) return { messages, next: cursor };
      }
      if (rows.length < 100) return { messages, next: null };
    }
    return { messages, next: cursor ?? null };
  }
  async send(owner: string, botId: string, integrationId: string, id: string, value: unknown) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !["requestId", "text", "confirm"].includes(key)) ||
      value.confirm !== true ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 10000
    )
      throw new BotError("invalidDelivery");
    const requestId = botConnectionId(value.requestId),
      config = await this.integrations.row(owner, botId, integrationId),
      storage = this.integrations.store.workspace,
      message = await storage.get<BotChannelRecord>(owner, { kind: "channel-message", id });
    if (
      !message ||
      message.botId !== botId ||
      message.data.integrationId !== integrationId ||
      !message.data.reply ||
      !message.data.source?.mail ||
      !message.data.connectionId ||
      (message.expiresAt ?? 0) <= Date.now() ||
      message.data.createdAt + config.data.config.retentionDays * 86400000 <= Date.now()
    )
      throw new BotError("notFound", 404);
    const receiptKey = { kind: "control" as const, id: "approval:" + requestId },
      fingerprint = createHash("sha256")
        .update(JSON.stringify([id, value.text]))
        .digest("hex"),
      prior = await storage.get<{ id: string; fingerprint: string }>(owner, receiptKey);
    if (prior) {
      if (prior.botId !== botId || prior.data.fingerprint !== fingerprint)
        throw new BotError("idempotencyConflict", 409);
      return { id: prior.data.id, duplicate: true };
    }
    if (message.data.reply.state !== "draft" && message.data.reply.state !== "failed")
      throw new BotError("deliveryCannotRetry", 409);
    const connection = await this.integrations.connections.row(owner, message.data.connectionId, "gmail");
    if (connection.data.state !== "ready") throw new BotError("connectionUnavailable", 409);
    const deliveryId = message.data.runId + ":approval:" + requestId,
      delivery: BotIntegrationDelivery = {
        id: botDeliveryIdentity(deliveryId),
        kind: "gmail",
        integrationId,
        runId: message.data.runId,
        generation: message.data.generation,
        part: -1,
        taskId: "",
        connectionId: connection.id,
        channelMessageId: message.id,
        automatic: false,
        approvedBy: owner,
        text: value.text.trim(),
        sources: [],
        source: message.data.source,
        attempts: 0,
      };
    if (
      !(await storage.batch(owner, {
        checks: [
          botIntegrationCheck(message),
          botIntegrationCheck(config),
          botIntegrationCheck(connection),
          { ...receiptKey, version: null },
          { kind: "delivery", id: deliveryId, version: null },
        ],
        puts: [
          {
            ...receiptKey,
            botId,
            state: "accepted",
            dueAt: null,
            expiresAt: message.expiresAt,
            data: { id: deliveryId, fingerprint },
          },
          {
            kind: "delivery",
            id: deliveryId,
            botId,
            state: "queued",
            dueAt: Date.now(),
            expiresAt: message.expiresAt,
            data: delivery,
          },
          {
            ...message,
            data: { ...message.data, reply: { ...message.data.reply, text: delivery.text, state: "queued" } },
          },
        ],
      }))
    )
      throw new BotError("conflict", 409);
    return { id: deliveryId, duplicate: false };
  }
}
