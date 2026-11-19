import type { BotWorkspaceBatch, BotWorkspaceRecord, BotWorkspaceStorage } from "../workspace/storage.js";
import { botIntegrationCheck, botIntegrationWrite, type BotIntegrationRecord } from "./configuration.js";
import { integrationRunWrite, type BotIntegrationRunRecord } from "./run-records.js";

export interface BotIntegrationLeaseContext {
  run: BotWorkspaceRecord<BotIntegrationRunRecord>;
  config: BotWorkspaceRecord<BotIntegrationRecord>;
}
export interface BotIntegrationLeaseUpdate {
  run: BotIntegrationRunRecord;
  dueAt: number | null;
  config?: { data: BotIntegrationRecord; dueAt: number | null; state?: string };
  checks?: BotWorkspaceBatch["checks"];
  puts?: BotWorkspaceBatch["puts"];
  removes?: BotWorkspaceBatch["removes"];
}
/** A running part must own both its lease and the configuration generation before committing any result. */
export class BotIntegrationLease {
  constructor(
    readonly storage: BotWorkspaceStorage,
    readonly owner: string,
    readonly id: string,
    readonly lease: string,
  ) {}
  async current(): Promise<BotIntegrationLeaseContext | null> {
    const run = await this.storage.get<BotIntegrationRunRecord>(this.owner, { kind: "run", id: this.id });
    if (
      !run ||
      run.data.lease !== this.lease ||
      !["collecting", "processing", "review"].includes(run.state) ||
      (run.dueAt ?? 0) <= Date.now()
    )
      return null;
    const config = await this.storage.get<BotIntegrationRecord>(this.owner, {
      kind: "integration",
      id: run.data.view.integrationId,
    });
    return config &&
      config.botId === run.botId &&
      config.data.generation === run.data.generation &&
      config.data.pendingRun === run.id
      ? { run, config }
      : null;
  }
  async transact(build: (context: BotIntegrationLeaseContext) => BotIntegrationLeaseUpdate) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.current();
      if (!current) return false;
      const update = build(current),
        puts = [integrationRunWrite(current.run, update.run, update.dueAt), ...(update.puts ?? [])];
      if (update.config)
        puts.push(botIntegrationWrite(current.config, update.config.data, update.config.dueAt, update.config.state));
      if (
        await this.storage.batch(this.owner, {
          checks: [botIntegrationCheck(current.run), botIntegrationCheck(current.config), ...(update.checks ?? [])],
          puts,
          removes: update.removes,
        })
      )
        return true;
    }
    return false;
  }
  touch() {
    return this.transact(({ run }) => ({ run: run.data, dueAt: Date.now() + 30000 }));
  }
}
