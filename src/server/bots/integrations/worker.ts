import { randomUUID } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotRepository } from "../repository.js";
import type { BotWorkspaceRecord, BotWorkspaceKind } from "../workspace/storage.js";
import { BotIntegrationRuns } from "./runs.js";
import {
  BotIntegrations,
  botIntegrationCheck as check,
  botIntegrationWrite,
  type BotIntegrationRecord,
} from "./configuration.js";
import { BotIntegrationLease } from "./run-lease.js";
import { integrationRunWrite, type BotIntegrationRunRecord } from "./run-records.js";
import { collectBotIntegration, botIntegrationSourcePorts, type BotIntegrationSourcePorts } from "./collection.js";
import { processBotIntegration } from "./processing.js";
import { BotIntegrationResults } from "./results.js";
import { BotIntegrationOutbox, type DeliveryRow } from "./outbox.js";
import type { BotIntegrationDelivery, BotChannelRecord } from "./delivery-records.js";
import { BotProviders } from "./providers.js";

/** The same durable records drive SQLite, MySQL and Compose peers; no process-local schedule is authoritative. */
export class BotIntegrationWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking: Promise<void> | undefined;
  private active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private lastCleanup = 0;
  private retentionCursor = new Map<string, string>();
  readonly runs: BotIntegrationRuns;
  readonly outbox: BotIntegrationOutbox;
  readonly results = new BotIntegrationResults();
  constructor(
    readonly store: BotRepository,
    readonly integrations: BotIntegrations,
    readonly providers: BotProviders,
    readonly wakeTasks: () => void,
    readonly sources: BotIntegrationSourcePorts = botIntegrationSourcePorts,
  ) {
    this.runs = new BotIntegrationRuns(integrations);
    this.outbox = new BotIntegrationOutbox(store, providers);
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    return (this.ticking ??= this.pump()
      .catch(() => {
        /* Durable due records remain available for the next tick. */
      })
      .finally(() => {
        this.ticking = undefined;
      }));
  }
  private launch(key: string, work: (signal: AbortSignal) => Promise<void>) {
    if (this.active.has(key) || this.active.size >= 4) return;
    const abort = new AbortController(),
      task = Promise.resolve()
        .then(() => work(AbortSignal.any([abort.signal, AbortSignal.timeout(25000)])))
        .catch(() => {
          /* Leases make interrupted work recoverable. */
        })
        .finally(() => this.active.delete(key));
    this.active.set(key, { abort, work: task });
  }
  private async pump() {
    const now = Date.now(),
      storage = this.store.workspace;
    for (const config of await storage.scan<BotIntegrationRecord>("integration", { dueBefore: now, limit: 40 })) {
      if (this.stopped) return;
      try {
        if ((await this.store.bot(config.owner, config.botId)).active) await this.runs.scheduled(config, now);
        else
          await storage.batch(config.owner, {
            checks: [check(config)],
            puts: [botIntegrationWrite(config, config.data, now + 60000)],
          });
      } catch (error) {
        if (!(error instanceof BotError)) throw error;
      }
    }
    for (const row of await storage.scan<BotIntegrationRunRecord>("run", { dueBefore: now, limit: 40 })) {
      if (this.stopped) return;
      if (["delivering", "canceled"].includes(row.state)) {
        await this.settle(row);
        continue;
      }
      if (!["queued", "collecting", "processing", "review"].includes(row.state)) continue;
      const key = row.owner + ":run:" + row.id;
      this.launch(key, (signal) => this.process(row, signal));
    }
    for (const row of await storage.scan<BotIntegrationDelivery>("delivery", { dueBefore: now, limit: 40 })) {
      if (this.stopped) return;
      if (row.state === "dispatching") await this.outbox.recover(row);
      else if (row.state === "queued")
        this.launch(row.owner + ":delivery:" + row.id, (signal) => this.outbox.dispatch(row, signal));
    }
    if (now - this.lastCleanup > 60000) {
      this.lastCleanup = now;
      await this.cleanup(now);
    }
  }
  private async process(row: BotWorkspaceRecord<BotIntegrationRunRecord>, signal: AbortSignal) {
    const storage = this.store.workspace,
      config = await storage.get<BotIntegrationRecord>(row.owner, {
        kind: "integration",
        id: row.data.view.integrationId,
      });
    if (
      !config ||
      config.data.generation !== row.data.generation ||
      config.data.pendingRun !== row.id ||
      (row.expiresAt ?? 0) <= Date.now()
    )
      return this.cancelRun(row);
    if (!(await this.store.bot(row.owner, row.botId)).active) {
      await storage.batch(row.owner, {
        checks: [check(row)],
        puts: [integrationRunWrite(row, row.data, Date.now() + 30000)],
      });
      return;
    }
    const leaseId = randomUUID(),
      state = row.state === "queued" || row.state === "collecting" ? "collecting" : "processing";
    if (
      !(await storage.batch(row.owner, {
        checks: [check(row), check(config)],
        activeBots: [row.botId],
        puts: [
          integrationRunWrite(
            row,
            { ...row.data, lease: leaseId, view: { ...row.data.view, state } },
            Date.now() + 30000,
          ),
        ],
      }))
    )
      return;
    const lease = new BotIntegrationLease(storage, row.owner, row.id, leaseId),
      heartbeat = setInterval(() => void lease.touch().catch(() => {}), 5000);
    try {
      if (state === "collecting") await collectBotIntegration(lease, this.providers, signal, this.sources);
      else {
        await processBotIntegration(lease, this.store, this.results);
        this.wakeTasks();
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async cancelRun(row: BotWorkspaceRecord<BotIntegrationRunRecord>) {
    if (
      await this.store.workspace.batch(row.owner, {
        checks: [check(row)],
        puts: [
          integrationRunWrite(
            row,
            { ...row.data, lease: undefined, view: { ...row.data.view, state: "canceled", completedAt: Date.now() } },
            Date.now(),
          ),
        ],
      })
    )
      await this.settle({
        ...row,
        state: "canceled",
        data: { ...row.data, view: { ...row.data.view, state: "canceled" } },
      });
  }
  private async settle(candidate: BotWorkspaceRecord<BotIntegrationRunRecord>) {
    const storage = this.store.workspace,
      row = await storage.get<BotIntegrationRunRecord>(candidate.owner, { kind: "run", id: candidate.id });
    if (!row) return;
    const canceled = row.state === "canceled",
      deliveries = await storage.list<BotIntegrationDelivery>(row.owner, "delivery", {
        botId: row.botId,
        prefix: row.id + ":",
        limit: 150,
      });
    if (canceled) {
      for (const part of row.data.parts)
        if (part.taskId)
          try {
            const task = await this.store.task(row.owner, part.taskId);
            if (["queued", "running", "review", "suspended"].includes(task.status))
              await this.store.lifecycle(row.owner, task.id, "cancel");
          } catch (error) {
            if (!(error instanceof BotError)) throw error;
          }
      for (const delivery of deliveries)
        if (delivery.state === "queued" && delivery.data.approvedBy !== row.owner)
          await this.outbox.cancel(delivery as DeliveryRow, "canceled");
    }
    const pending = !canceled && deliveries.some((d) => ["queued", "dispatching"].includes(d.state)),
      attention = deliveries.some((d) => ["failed", "unknown"].includes(d.state));
    const config = await storage.get<BotIntegrationRecord>(row.owner, {
      kind: "integration",
      id: row.data.view.integrationId,
    });
    const view = {
      ...row.data.view,
      state: canceled
        ? ("canceled" as const)
        : pending
          ? ("delivering" as const)
          : attention
            ? ("review" as const)
            : ("complete" as const),
      completedAt: pending ? null : Date.now(),
    };
    const release = config?.data.pendingRun === row.id,
      currentLast = config?.data.lastRun?.id === row.id;
    await storage.batch(row.owner, {
      checks: [check(row), ...(config && (release || currentLast) ? [check(config)] : [])],
      puts: [
        integrationRunWrite(row, { ...row.data, view }, pending ? Date.now() + 2000 : null),
        ...(config && (release || currentLast)
          ? [
              botIntegrationWrite(
                config,
                { ...config.data, ...(release ? { pendingRun: null } : {}), ...(currentLast ? { lastRun: view } : {}) },
                release ? (config.data.resumeAt ?? null) : config.dueAt,
                view.state === "review" && config.data.config.enabled ? "error" : undefined,
              ),
            ]
          : []),
      ],
    });
  }
  private async cleanup(now: number) {
    const storage = this.store.workspace;
    for (const kind of [
      "channel-message",
      "run",
      "delivery",
      "task-link",
      "source-item",
      "control",
    ] as BotWorkspaceKind[]) {
      for (const row of await storage.scan(kind, { expiresBefore: now, limit: 80 })) {
        if (kind === "delivery" && row.state === "dispatching") continue;
        if (kind === "run" && ["queued", "collecting", "processing", "review"].includes(row.state)) {
          await this.cancelRun(row as BotWorkspaceRecord<BotIntegrationRunRecord>);
          continue;
        }
        await storage.batch(row.owner, { checks: [check(row)], removes: [{ kind, id: row.id }] });
      }
    }
    // Shorter retention takes effect for retained payloads. Expiry is never extended by a later edit.
    for (const kind of ["channel-message", "run", "delivery", "task-link"] as const) {
      const page = await storage.scan<BotChannelRecord | BotIntegrationRunRecord | BotIntegrationDelivery>(kind, {
        limit: 80,
        after: this.retentionCursor.get(kind),
      });
      if (page.length === 80) this.retentionCursor.set(kind, page.at(-1)!.id);
      else this.retentionCursor.delete(kind);
      for (const row of page) {
        const integrationId =
          "integrationId" in row.data
            ? row.data.integrationId
            : "view" in row.data
              ? row.data.view.integrationId
              : undefined;
        if (!integrationId) continue;
        const config = await storage.get<BotIntegrationRecord>(row.owner, { kind: "integration", id: integrationId });
        const createdAt =
          "createdAt" in row.data
            ? row.data.createdAt
            : "view" in row.data
              ? row.data.view.createdAt
              : Number(row.id.split(":")[1]);
        const expiresAt = createdAt + (config?.data.config.retentionDays ?? 30) * 86400000;
        if (row.expiresAt !== null && Number.isSafeInteger(expiresAt) && expiresAt < row.expiresAt)
          await storage.batch(row.owner, { checks: [check(row)], puts: [{ ...row, expiresAt }] });
      }
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.ticking;
    for (const task of this.active.values()) task.abort.abort();
    await Promise.allSettled([...this.active.values()].map((t) => t.work));
  }
}
