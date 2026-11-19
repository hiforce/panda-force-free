import { createHash, randomUUID } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotRepository } from "../repository.js";
import type { BotWorkspaceRecord, BotWorkspaceBatch } from "../workspace/storage.js";
import { botIntegrationCheck, type BotIntegrationRecord } from "./configuration.js";
import { botDeliveryWrite, type BotChannelRecord, type BotIntegrationDelivery } from "./delivery-records.js";
import type { BotIntegrationRunRecord } from "./run-records.js";
import { BotProviders, BotProviderError } from "./providers.js";
import { sendGmailReply, reconcileGmailReply } from "./mail.js";

export type DeliveryRow = BotWorkspaceRecord<BotIntegrationDelivery>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const check = botIntegrationCheck;
/** A dispatch is durable before network I/O; only explicit rejections can be retried automatically. */
export class BotIntegrationOutbox {
  constructor(
    readonly store: BotRepository,
    readonly providers: BotProviders,
  ) {}
  async finish(
    row: DeliveryRow,
    state: string,
    failure?: string,
    receipt?: BotIntegrationDelivery["receipt"],
    dueAt: number | null = null,
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const fresh = await this.store.workspace.get<BotIntegrationDelivery>(row.owner, { kind: "delivery", id: row.id });
      if (!fresh || fresh.data.lease !== row.data.lease || fresh.state !== "dispatching") return;
      const channel = fresh.data.channelMessageId
        ? await this.store.workspace.get<BotChannelRecord>(row.owner, {
            kind: "channel-message",
            id: fresh.data.channelMessageId,
          })
        : null;
      const data = { ...fresh.data, lease: undefined, failure, ...(receipt ? { receipt } : {}) };
      const batch: BotWorkspaceBatch = { checks: [check(fresh)], puts: [botDeliveryWrite(fresh, data, state, dueAt)] };
      if (channel && data.kind === "gmail" && channel.data.reply) {
        batch.checks.push(check(channel));
        batch.puts!.push({
          ...channel,
          data: {
            ...channel.data,
            reply: {
              ...channel.data.reply,
              state:
                state === "sent" ? "sent" : state === "unknown" ? "unknown" : state === "queued" ? "queued" : "failed",
              ...(receipt ? { receipt: receipt.id } : {}),
            },
          },
        });
      }
      const run = await this.store.workspace.get<BotIntegrationRunRecord>(row.owner, {
        kind: "run",
        id: fresh.data.runId,
      });
      if (run && run.state !== "canceled" && run.data.parts.every((part) => part.applied)) {
        batch.checks.push(check(run));
        batch.puts!.push({
          ...run,
          state: "delivering",
          dueAt: Date.now(),
          data: { ...run.data, view: { ...run.data.view, state: "delivering" } },
        });
      }
      if (await this.store.workspace.batch(row.owner, batch)) return;
    }
  }
  async dispatch(candidate: DeliveryRow, signal: AbortSignal) {
    let row = await this.store.workspace.get<BotIntegrationDelivery>(candidate.owner, {
      kind: "delivery",
      id: candidate.id,
    });
    if (!row || row.state !== "queued" || (row.dueAt ?? Infinity) > Date.now()) return;
    const owner = row.owner,
      d = row.data,
      now = Date.now();
    const config = await this.store.workspace.get<BotIntegrationRecord>(owner, {
        kind: "integration",
        id: d.integrationId,
      }),
      run = await this.store.workspace.get<BotIntegrationRunRecord>(owner, { kind: "run", id: d.runId });
    const bot = await this.store.bot(owner, row.botId);
    const invalid =
      !config ||
      !run ||
      (run.state === "canceled" && d.approvedBy !== owner) ||
      run.data.view.preview ||
      run.data.view.createdAt + config.data.config.retentionDays * 86400000 <= now ||
      (row.expiresAt ?? 0) <= now ||
      (d.approvedBy !== owner &&
        (config.data.generation !== d.generation || (!config.data.config.enabled && !run.data.manual)));
    if (invalid || !bot.active) return this.cancel(row, invalid ? "canceled" : "botPaused");
    const connection = await this.providers.connections.row(owner, d.connectionId, d.kind);
    if (connection.data.state !== "ready") return this.reject(row, "connectionUnavailable");
    // Refresh is not a message send. Resolve it before reserving the irreversible dispatch.
    try {
      await this.providers.access(owner, connection, signal);
    } catch (error) {
      return this.reject(row, error instanceof BotError ? error.code : "connectionUnavailable");
    }
    const ready = await this.providers.connections.row(owner, d.connectionId, d.kind);
    let task;
    if (d.approvedBy !== owner) {
      try {
        task = await this.store.task(owner, d.taskId);
      } catch {
        return this.cancel(row, "taskUnavailable");
      }
      if (task.status !== "completed" || task.botId !== row.botId) return this.cancel(row, "taskUnavailable");
    }
    const batch: BotWorkspaceBatch = {
      checks: [check(row), check(config!), check(run!), check(ready)],
      puts: [],
      activeBots: [row.botId],
      ...(task ? { completedTasks: [{ id: task.id, botId: row.botId, updatedAt: task.updatedAt }] } : {}),
    };
    const next = { ...d, lease: randomUUID(), dispatchedAt: now, attempts: d.attempts + 1 };
    if (d.kind === "gmail") {
      if (
        !d.source?.mail ||
        d.source.mail.from === ready.data.account ||
        (d.source.mail.account && d.source.mail.account !== ready.data.account)
      )
        return this.reject(row, "invalidDelivery");
      const markerKey = { kind: "control" as const, id: "reply:" + digest(d.connectionId + ":" + d.source.id) },
        marker = await this.store.workspace.get<{ deliveryId: string }>(owner, markerKey);
      if (marker && marker.data.deliveryId !== row.id) return this.reject(row, "alreadyReplied");
      batch.checks.push({ ...markerKey, version: marker?.version ?? null });
      if (!marker) {
        if (d.automatic) {
          const policy = config!.data.config.mail;
          if (
            !config!.data.autoConsent ||
            policy.mode !== "auto" ||
            !policy.allowSenders.includes(d.source.mail.from) ||
            d.source.mail.autoSubmitted ||
            d.source.truncated
          )
            return this.reject(row, "reviewRequired");
          const quotaKey = {
              kind: "control" as const,
              id: "mail-quota:" + digest(d.connectionId) + ":" + new Date(now).toISOString().slice(0, 10),
            },
            quota = await this.store.workspace.get<{ count: number }>(owner, quotaKey),
            count = quota?.data.count ?? 0;
          if (count >= policy.dailyLimit) return this.reject(row, "dailyLimit");
          batch.checks.push({ ...quotaKey, version: quota?.version ?? null });
          batch.puts!.push({
            ...quotaKey,
            botId: row.botId,
            state: "quota",
            dueAt: null,
            expiresAt: now + 2 * 86400000,
            data: { count: count + 1 },
          });
        }
        batch.puts!.push({
          ...markerKey,
          botId: row.botId,
          state: "reserved",
          dueAt: null,
          expiresAt: now + 365 * 86400000,
          data: { deliveryId: row.id },
        });
      }
    }
    batch.puts!.push(botDeliveryWrite(row, next, "dispatching", now + 30000));
    if (!(await this.store.workspace.batch(owner, batch))) return;
    row = { ...row, version: row.version + 1, data: next, state: "dispatching" };
    let receipt: BotIntegrationDelivery["receipt"];
    try {
      receipt =
        d.kind === "slack"
          ? await this.providers.slack(
              owner,
              d.connectionId,
              d.channel!,
              d.text + (d.sources.length ? "\n\n" + d.sources.map((s) => s.title + "\n" + s.url).join("\n\n") : ""),
              d.id,
              signal,
            )
          : await sendGmailReply(this.providers, owner, d.connectionId, d.source!, d.text, d.id, signal);
    } catch (error) {
      const rejected = (error instanceof BotProviderError && error.outcome === "rejected") || error instanceof BotError,
        retry = error instanceof BotProviderError && error.code === "rateLimited" && next.attempts < 5,
        code = error instanceof BotProviderError || error instanceof BotError ? error.code : "unknown";
      await this.finish(
        row,
        retry ? "queued" : rejected ? "failed" : "unknown",
        code,
        undefined,
        retry ? Date.now() + Math.max(1, (error as BotProviderError).retryAfter) * 1000 : null,
      );
      return;
    }
    // A database failure after provider acknowledgement must remain recoverable as unknown, never a rejected send.
    await this.finish(row, "sent", undefined, receipt);
  }
  async cancel(row: DeliveryRow, failure: string) {
    return this.reject(row, failure, "canceled");
  }
  async reject(row: DeliveryRow, failure: string, state = "failed") {
    // Use the same receipt update path without entering the network.
    const claimed = { ...row, data: { ...row.data, lease: randomUUID() }, state: "dispatching" };
    if (
      await this.store.workspace.batch(row.owner, {
        checks: [check(row)],
        puts: [botDeliveryWrite(row, claimed.data, "dispatching", Date.now() + 30000)],
      })
    )
      await this.finish(claimed, state, failure);
  }
  async recover(row: DeliveryRow) {
    if (row.state === "dispatching" && (row.dueAt ?? Infinity) <= Date.now())
      await this.finish(row, "unknown", "interrupted");
  }
  async reconcile(owner: string, botId: string, id: string, signal: AbortSignal) {
    const row = await this.store.workspace.get<BotIntegrationDelivery>(owner, { kind: "delivery", id });
    if (!row || row.botId !== botId || (row.expiresAt ?? 0) <= Date.now()) throw new BotError("notFound", 404);
    if (row.state !== "unknown" || row.data.kind !== "gmail") throw new BotError("deliveryNotReconcilable", 409);
    const receipt = await reconcileGmailReply(this.providers, owner, row.data.connectionId, row.data.id, signal);
    if (!receipt) return { found: false };
    const claimed = { ...row, data: { ...row.data, lease: randomUUID() } };
    if (
      await this.store.workspace.batch(owner, {
        checks: [check(row)],
        puts: [botDeliveryWrite(row, claimed.data, "dispatching", Date.now() + 30000)],
      })
    )
      await this.finish(claimed, "sent", undefined, receipt);
    return { found: true };
  }
  async retry(owner: string, botId: string, id: string) {
    await this.store.bot(owner, botId);
    const row = await this.store.workspace.get<BotIntegrationDelivery>(owner, { kind: "delivery", id });
    if (!row || row.botId !== botId || (row.expiresAt ?? 0) <= Date.now()) throw new BotError("notFound", 404);
    if (row.state !== "failed" || row.data.failure === "alreadyReplied") throw new BotError("deliveryCannotRetry", 409);
    if (
      !(await this.store.workspace.batch(owner, {
        checks: [check(row)],
        puts: [botDeliveryWrite(row, { ...row.data, failure: undefined }, "queued", Date.now())],
      }))
    )
      throw new BotError("conflict", 409);
  }
}
