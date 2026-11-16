import type { MetadataStore } from "../../shared/async-value.js";
import type { ResourceBuildRequest } from "../../shared/builds/resources.js";
import { terminalBuildRun, type BuildRun } from "../../shared/builds/run.js";
import type { ResourceBuildInputs, ResourceInputLedger, ResourceInputReservation } from "./resource-input-port.js";
import { SiteBuildError } from "./errors.js";
/** Both sample and project admissions keep their own receipts while sharing durable input recovery and cleanup. */
export class ResourceInputLifecycle<Job extends BuildRun> {
  private recovery: Promise<void> | null = null;
  constructor(
    private jobs: MetadataStore<ResourceInputLedger<Job>>,
    private files: ResourceBuildInputs,
    private wake: () => void,
    private now = Date.now,
  ) {}
  async create(job: Job, input: ResourceBuildRequest): Promise<Job> {
    try {
      this.files.prepare(job.id);
      const bytes = await this.files.write(job.id, input),
        saved = await this.jobs.accept(job.id, input.digest, bytes);
      this.wake();
      return saved;
    } catch (error) {
      const current = await this.jobs.get(job.id);
      if (!terminalBuildRun(current)) await this.jobs.update(job.id, { phase: "failed", error: "snapshotUnavailable" });
      await this.cleanup(job.id);
      if (current.phase === "cancelled") return current;
      throw error;
    }
  }
  async resume(value: ResourceInputReservation<Job>): Promise<Job> {
    if (value.ready || terminalBuildRun(value.job)) return value.job;
    try {
      const job = await this.files.with(
        value.job.id,
        value.job.inputHash,
        async (input, bytes) => await this.jobs.accept(value.job.id, input.digest, bytes),
      );
      this.wake();
      return job;
    } catch (error) {
      if (error instanceof SiteBuildError && error.code === "inputBusy") throw error;
      if (!(error instanceof SiteBuildError) || error.code !== "snapshotUnavailable") throw error;
      if (this.now() - value.job.createdAt < 180000) throw new SiteBuildError("inputBusy", 429);
      const failed = await this.jobs.update(value.job.id, { phase: "failed", error: "snapshotUnavailable" });
      await this.cleanup(value.job.id);
      return failed;
    }
  }
  async cleanup(id: string) {
    if (!terminalBuildRun(await this.jobs.get(id))) return;
    await this.files.remove(id);
    await this.jobs.released(id);
  }
  recover(): Promise<void> {
    return (this.recovery ??= Promise.resolve()
      .then(() => this.recoverPending())
      .finally(() => {
        this.recovery = null;
      }));
  }
  private async recoverPending() {
    for (const pending of await this.jobs.pending()) {
      try {
        await this.resume(pending);
      } catch (error) {
        if (!(error instanceof SiteBuildError && error.code === "inputBusy")) throw error;
      }
    }
    for (const job of await this.jobs.cleanup()) await this.cleanup(job.id);
  }
}
