import { randomUUID } from "node:crypto";
import { isRecord } from "../../../shared/records.js";
import { BotError } from "../../../shared/bots/contracts.js";
import {
  BotIntegrations,
  botIntegrationCheck,
  botIntegrationWrite,
  type BotIntegrationRecord,
} from "./configuration.js";
import { botConnectionId } from "./connections.js";
import { nextBotSchedule, botScheduleDay } from "./schedule.js";
import { integrationRunId, integrationRunWrite, type BotIntegrationRunRecord } from "./run-records.js";
import type { BotWorkspaceRecord } from "../workspace/storage.js";

export class BotIntegrationRuns {
  constructor(readonly integrations: BotIntegrations) {}
  async list(owner: string, botId: string, integrationId: string, before?: string) {
    const config = await this.integrations.row(owner, botId, integrationId);
    const rows = await this.integrations.store.workspace.list<BotIntegrationRunRecord>(owner, "run", {
      botId,
      prefix: integrationId + ":",
      limit: 51,
      descending: true,
      liveAt: Date.now(),
      ...(before ? { before } : {}),
    });
    return {
      runs: rows
        .slice(0, 50)
        .filter((r) => r.data.view.createdAt + config.data.config.retentionDays * 86400000 > Date.now())
        .map((r) => r.data.view),
      next: rows.length > 50 ? rows[49]!.id : null,
    };
  }
  async row(owner: string, botId: string, integrationId: string, runId: string) {
    const config = await this.integrations.row(owner, botId, integrationId);
    if (!runId.startsWith(integrationId + ":")) throw new BotError("notFound", 404);
    const row = await this.integrations.store.workspace.get<BotIntegrationRunRecord>(owner, { kind: "run", id: runId });
    if (
      !row ||
      row.botId !== botId ||
      (row.expiresAt ?? 0) <= Date.now() ||
      row.data.view.createdAt + config.data.config.retentionDays * 86400000 <= Date.now()
    )
      throw new BotError("notFound", 404);
    return row;
  }
  async manual(owner: string, botId: string, integrationId: string, value: unknown) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((k) => !["requestId", "preview", "revision"].includes(k)) ||
      typeof value.preview !== "boolean" ||
      !Number.isSafeInteger(value.revision)
    )
      throw new BotError("invalidRun");
    const requestId = botConnectionId(value.requestId),
      config = await this.integrations.row(owner, botId, integrationId),
      existing = await this.integrations.store.workspace.get<{
        runId: string;
        preview: boolean;
        manual: boolean;
        revision: number;
      }>(owner, { kind: "control", id: integrationId + ":run:" + requestId });
    if (existing) {
      if (
        existing.botId !== botId ||
        existing.data.preview !== value.preview ||
        !existing.data.manual ||
        existing.data.revision !== value.revision
      )
        throw new BotError("idempotencyConflict", 409);
      return { run: (await this.row(owner, botId, integrationId, existing.data.runId)).data.view, duplicate: true };
    }
    if (config.version !== value.revision) throw new BotError("staleIntegration", 409);
    try {
      return await this.create(config, requestId, value.preview, true);
    } catch (error) {
      if (!(error instanceof BotError) || error.code !== "staleIntegration") throw error;
      const receipt = await this.integrations.store.workspace.get<{
        runId: string;
        preview: boolean;
        manual: boolean;
        revision: number;
      }>(owner, { kind: "control", id: integrationId + ":run:" + requestId });
      if (
        !receipt ||
        receipt.botId !== botId ||
        receipt.data.preview !== value.preview ||
        !receipt.data.manual ||
        receipt.data.revision !== value.revision
      )
        throw error;
      return { run: (await this.row(owner, botId, integrationId, receipt.data.runId)).data.view, duplicate: true };
    }
  }
  async scheduled(row: BotWorkspaceRecord<BotIntegrationRecord>, now = Date.now()) {
    if (!row.data.config.enabled || row.dueAt === null || row.dueAt > now || row.data.pendingRun) return null;
    return this.create(row, randomUUID(), false, false, now);
  }
  private async create(
    row: BotWorkspaceRecord<BotIntegrationRecord>,
    requestId: string,
    preview: boolean,
    manual: boolean,
    now = Date.now(),
  ) {
    if (row.data.pendingRun) throw new BotError("integrationBusy", 409);
    const id = integrationRunId(row.id, requestId, now),
      record: BotIntegrationRunRecord = {
        view: {
          id,
          integrationId: row.id,
          state: "queued",
          preview,
          createdAt: now,
          completedAt: null,
          itemCount: 0,
          taskIds: [],
        },
        config: row.data.config,
        locale: row.data.locale ?? "en",
        generation: row.data.generation,
        manual,
        items: [],
        parts: [],
        limited: false,
      },
      key = { kind: "run" as const, id },
      receipt = { kind: "control" as const, id: row.id + ":run:" + requestId },
      day = row.data.config.schedule.kind === "daily" ? botScheduleDay(row.data.config.schedule, now) : undefined,
      next = { ...row.data, pendingRun: id, lastRun: record.view, ...(!manual && day ? { lastLocalDay: day } : {}) };
    next.resumeAt = preview || manual ? row.dueAt : nextBotSchedule(record.config.schedule, now, next.lastLocalDay);
    const accepted = await this.integrations.store.workspace.batch(row.owner, {
      checks: [botIntegrationCheck(row), { ...key, version: null }, { ...receipt, version: null }],
      puts: [
        integrationRunWrite({ ...row, id }, record, now),
        {
          ...receipt,
          botId: row.botId,
          state: "accepted",
          dueAt: null,
          expiresAt: now + record.config.retentionDays * 86400000,
          data: { runId: id, preview, manual, revision: row.version },
        },
        botIntegrationWrite(row, next, null),
      ],
    });
    if (!accepted) throw new BotError("staleIntegration", 409);
    return { run: record.view, duplicate: false };
  }
  async cancel(owner: string, botId: string, integrationId: string, runId: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.row(owner, botId, integrationId, runId);
      if (["complete", "canceled"].includes(row.state)) return row.data.view;
      const data: BotIntegrationRunRecord = {
        ...row.data,
        lease: undefined,
        view: { ...row.data.view, state: "canceled", completedAt: Date.now() },
      };
      if (
        await this.integrations.store.workspace.batch(owner, {
          checks: [botIntegrationCheck(row)],
          puts: [integrationRunWrite(row, data, Date.now())],
        })
      )
        return data.view;
    }
    throw new BotError("conflict", 409);
  }
}
