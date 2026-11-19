import { createHash } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type {
  BotIntegrationConfig,
  BotIntegrationRunView,
  BotIntegrationView,
  BotSource,
} from "../../../shared/bots/integrations.js";
import type { BotRepository } from "../repository.js";
import type { BotWorkspaceRecord } from "../workspace/storage.js";
import { BotConnections, botConnectionId } from "./connections.js";
import { botMailAddress } from "./providers.js";
import { botFeedUrl, type BotFeedCursor } from "./feed.js";
import { botSchedule, nextBotSchedule } from "./schedule.js";
import { botWorkspaceSlot } from "./quota.js";
import { integrationRunWrite, type BotIntegrationRunRecord } from "./run-records.js";
import type { SupportedLocale } from "../../../shared/i18n/contracts.js";

export interface BotIntegrationRecord {
  config: BotIntegrationConfig;
  locale?: SupportedLocale;
  generation: number;
  createdAt: number;
  sourceSinceAt?: number;
  updatedAt: number;
  cursor: BotFeedCursor & { pageToken?: string };
  lastRun: BotIntegrationRunView | null;
  pendingRun: string | null;
  resumeAt?: number | null;
  lastLocalDay?: string;
  autoConsent?: { at: number; owner: string; policy: string };
  failure?: string;
}
export const botIntegrationCheck = (row: BotWorkspaceRecord) => ({ kind: row.kind, id: row.id, version: row.version });
export const botIntegrationWrite = (
  row: BotWorkspaceRecord,
  data: BotIntegrationRecord,
  dueAt: number | null,
  state = data.config.enabled ? "enabled" : "paused",
) => ({ kind: row.kind, id: row.id, botId: row.botId, data, state, dueAt, expiresAt: null });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function text(value: unknown, max: number, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\0]/.test(value))
    throw new BotError("invalidIntegration");
  return value.trim();
}
function fields(value: unknown, allowed: string[]) {
  if (!isRecord(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    throw new BotError("invalidIntegration");
  return value;
}
export function botIntegrationConfig(botId: string, value: unknown): BotIntegrationConfig {
  const input = fields(value, [
      "id",
      "botId",
      "revision",
      "name",
      "source",
      "schedule",
      "instructions",
      "enabled",
      "retentionDays",
      "delivery",
      "mail",
      "confirmAutoReply",
    ]),
    id = botConnectionId(input.id),
    source = fields(input.source, ["kind", "url", "connectionId", "query"]),
    delivery = fields(input.delivery, ["channel", "slack"]),
    mail = fields(input.mail ?? { mode: "draft", allowSenders: [], dailyLimit: 5 }, [
      "mode",
      "allowSenders",
      "dailyLimit",
    ]);
  if (
    (input.botId !== undefined && input.botId !== botId) ||
    typeof input.enabled !== "boolean" ||
    !Number.isInteger(input.retentionDays) ||
    Number(input.retentionDays) < 1 ||
    Number(input.retentionDays) > 365 ||
    typeof delivery.channel !== "boolean"
  )
    throw new BotError("invalidIntegration");
  let parsedSource: BotSource;
  if (source.kind === "rss" && Object.keys(source).every((k) => ["kind", "url"].includes(k)))
    parsedSource = { kind: "rss", url: botFeedUrl(source.url) };
  else if (source.kind === "gmail" && Object.keys(source).every((k) => ["kind", "connectionId", "query"].includes(k)))
    parsedSource = {
      kind: "gmail",
      connectionId: botConnectionId(source.connectionId),
      query: text(source.query ?? "", 500, true),
    };
  else throw new BotError("invalidIntegration");
  if (
    !["draft", "auto"].includes(String(mail.mode)) ||
    !Array.isArray(mail.allowSenders) ||
    mail.allowSenders.length > 50 ||
    !Number.isInteger(mail.dailyLimit) ||
    Number(mail.dailyLimit) < 1 ||
    Number(mail.dailyLimit) > 50
  )
    throw new BotError("invalidMailPolicy");
  const allowSenders = [...new Set(mail.allowSenders.map(botMailAddress))];
  if (mail.mode === "auto" && (parsedSource.kind !== "gmail" || !allowSenders.length))
    throw new BotError("invalidMailPolicy");
  let slack: BotIntegrationConfig["delivery"]["slack"];
  if (delivery.slack !== undefined) {
    const selected = fields(delivery.slack, ["connectionId", "channel"]),
      channel = text(selected.channel, 40);
    if (!/^[CGD][A-Z0-9]{6,32}$/.test(channel)) throw new BotError("invalidDelivery");
    slack = { connectionId: botConnectionId(selected.connectionId), channel };
  }
  if (!delivery.channel && (!slack || parsedSource.kind === "gmail")) throw new BotError("invalidDelivery");
  return {
    id,
    botId,
    name: text(input.name, 120),
    source: parsedSource,
    schedule: botSchedule(input.schedule),
    instructions: text(input.instructions ?? "", 8000, true),
    enabled: input.enabled,
    retentionDays: Number(input.retentionDays),
    delivery: { channel: delivery.channel, ...(slack ? { slack } : {}) },
    mail: { mode: mail.mode as "draft" | "auto", allowSenders, dailyLimit: Number(mail.dailyLimit) },
  };
}
export function integrationView(row: BotWorkspaceRecord<BotIntegrationRecord>): BotIntegrationView {
  return {
    config: row.data.config,
    revision: row.version,
    nextRunAt: row.data.pendingRun ? (row.data.resumeAt ?? null) : row.dueAt,
    lastRun: row.data.lastRun,
  };
}
/** Configuration changes fence running work; pausing an integration cannot be undone by an older worker. */
export class BotIntegrations {
  constructor(
    readonly store: BotRepository,
    readonly connections: BotConnections,
  ) {}
  async bot(owner: string, botId: string) {
    if ((await this.store.bot(owner, botId)).id !== botId) throw new BotError("notFound", 404);
  }
  async row(owner: string, botId: string, id: string) {
    await this.bot(owner, botId);
    const row = await this.store.workspace.get<BotIntegrationRecord>(owner, {
      kind: "integration",
      id: botConnectionId(id),
    });
    if (!row || row.botId !== botId) throw new BotError("notFound", 404);
    return row;
  }
  async list(owner: string, botId: string) {
    await this.bot(owner, botId);
    return (await this.store.workspace.list<BotIntegrationRecord>(owner, "integration", { botId, limit: 101 })).map(
      integrationView,
    );
  }
  async save(owner: string, botId: string, value: unknown, locale?: SupportedLocale) {
    await this.bot(owner, botId);
    const config = botIntegrationConfig(botId, value),
      input = value as Record<string, unknown>,
      prior = await this.store.workspace.get<BotIntegrationRecord>(owner, { kind: "integration", id: config.id }),
      revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 0 || (prior && prior.botId !== botId))
      throw new BotError("invalidIntegration");
    if ((prior?.version ?? 0) !== revision) throw new BotError("staleIntegration", 409);
    const slot = prior
      ? { checks: [], puts: [] }
      : await botWorkspaceSlot(this.store.workspace, owner, "integration", botId);
    const connectionChecks: ReturnType<typeof botIntegrationCheck>[] = [];
    for (const [connectionId, kind] of [
      ...(config.source.kind === "gmail" ? [[config.source.connectionId, "gmail"]] : []),
      ...(config.delivery.slack ? [[config.delivery.slack.connectionId, "slack"]] : []),
    ]) {
      const row = await this.connections.row(owner, connectionId!, kind as "gmail" | "slack");
      connectionChecks.push(botIntegrationCheck(row));
      if (row.data.state === "disabled" || (config.enabled && row.data.state !== "ready"))
        throw new BotError("connectionUnavailable", 409);
    }
    const policy = hash([config.source, config.instructions, config.mail]),
      consent = prior?.data.autoConsent;
    if (
      config.mail.mode === "auto" &&
      (consent?.policy !== policy || consent.owner !== owner) &&
      input.confirmAutoReply !== true
    )
      throw new BotError("autoReplyConfirmationRequired", 409);
    const now = Date.now(),
      nextRunAt = config.enabled ? nextBotSchedule(config.schedule, now) : null,
      sourceChanged = prior && hash(prior.data.config.source) !== hash(config.source),
      data: BotIntegrationRecord = {
        config,
        locale: locale ?? prior?.data.locale ?? "en",
        createdAt: prior?.data.createdAt ?? now,
        sourceSinceAt: sourceChanged ? now : (prior?.data.sourceSinceAt ?? now),
        updatedAt: now,
        generation: (prior?.data.generation ?? 0) + 1,
        cursor: sourceChanged ? {} : (prior?.data.cursor ?? {}),
        pendingRun: prior?.data.pendingRun ?? null,
        resumeAt: nextRunAt,
        lastRun: prior?.data.lastRun ?? null,
        ...(config.mail.mode === "auto"
          ? { autoConsent: consent?.policy === policy ? consent : { owner, policy, at: now } }
          : {}),
      };
    const pending = prior?.data.pendingRun
      ? await this.store.workspace.get<BotIntegrationRunRecord>(owner, { kind: "run", id: prior.data.pendingRun })
      : null;
    const key = { kind: "integration" as const, id: config.id };
    if (
      !(await this.store.workspace.batch(owner, {
        checks: [
          { ...key, version: prior?.version ?? null },
          ...slot.checks,
          ...connectionChecks,
          ...(pending ? [botIntegrationCheck(pending)] : []),
        ],
        puts: [
          {
            ...key,
            botId,
            data,
            state: config.enabled ? "enabled" : "paused",
            dueAt: data.pendingRun ? null : nextRunAt,
            expiresAt: null,
          },
          ...(slot.puts ?? []),
          ...(pending
            ? [
                integrationRunWrite(
                  pending,
                  {
                    ...pending.data,
                    lease: undefined,
                    view: { ...pending.data.view, state: "canceled", completedAt: now },
                  },
                  now,
                ),
              ]
            : []),
        ],
      }))
    )
      throw new BotError("staleIntegration", 409);
    return integrationView((await this.row(owner, botId, config.id))!);
  }
}
