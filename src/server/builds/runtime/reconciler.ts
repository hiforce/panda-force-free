import { terminalBuildRun, type BuildRun } from "../../../shared/builds/run.js";
import type { SiteExecutor } from "../executor-port.js";
import { SiteBuildError } from "../errors.js";
import { artifactStorageBudget } from "./budget.js";
import type { BuildRunStoreMetadata, BuildRunArtifacts, BuildRunRetention, BuildRunDispatcher } from "./ports.js";
/** Polling resumes persisted intent. Only an explicit new ID may execute a failed build again. */
export class BuildRunReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private closed = false;
  private retries = new Map<
    string,
    {
      next: number;
      count: number;
    }
  >();
  constructor(
    private jobs: BuildRunStoreMetadata,
    private artifacts: BuildRunArtifacts,
    private executor: SiteExecutor,
    private report: (event: object) => void,
    private retention: BuildRunRetention,
    private dispatcher: BuildRunDispatcher,
    private readonly eventPrefix = "build-run",
    private now: () => number = Date.now,
  ) {}
  wake() {
    if (this.closed || this.flight || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, 100);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flight = Promise.resolve()
      .then(() => this.run())
      .finally(() => {
        this.flight = null;
        if (!this.closed) {
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick();
          }, 2000);
          this.timer.unref();
        }
      });
    return this.flight;
  }
  private async run() {
    try {
      for (const job of await this.jobs.active()) {
        if (this.closed) return;
        if ((this.retries.get(job.id)?.next || 0) > this.now() && job.phase !== "cancelling") continue;
        await this.reconcile(job);
      }
    } catch {
      if (!this.closed) this.report({ event: this.eventPrefix + ".reconciliation-unavailable" });
    }
  }
  private async reconcile(job: BuildRun) {
    try {
      if (job.phase === "queued" && this.now() - job.createdAt > 86400000)
        throw new SiteBuildError("requestExpired", 409);
      const remote =
        job.phase === "cancelling"
          ? await this.executor.cancel(job.id)
          : job.phase === "queued"
            ? await this.dispatcher.start(job, {
                closed: () => this.closed,
                current: async () => await this.jobs.get(job.id),
              })
            : await this.executor.status(job.id);
      if (this.closed) return;
      if (remote.inputHash !== job.inputHash || remote.engine !== job.engine || remote.id !== job.id)
        throw new SiteBuildError("executorProtocol", 409);
      this.retries.delete(job.id);
      const current = await this.jobs.get(job.id);
      const phase =
        remote.phase === "completed"
          ? "collecting"
          : remote.phase === "failed"
            ? remote.error === "cancelled"
              ? "cancelled"
              : "failed"
            : current.phase === "cancelling"
              ? "cancelling"
              : remote.phase;
      await this.jobs.update(job.id, {
        phase,
        connection: "ready",
        error: remote.error || null,
        image: remote.image || null,
      });
      try {
        const logs = await this.executor.logs(job.id);
        if (this.closed) return;
        await this.jobs.saveLogs(job.id, logs);
      } catch {
        /* Log transport is independent of the authoritative execution state. */
      }
      if (this.closed) return;
      if (phase === "collecting") {
        const output = await this.executor.result(job.id);
        if (this.closed) return;
        await this.retention.prune(artifactStorageBudget(output.bytes, output.files.length));
        if (this.closed) return;
        const artifact = await this.artifacts.put(job.id, output);
        if (this.closed) return;
        await this.jobs.update(job.id, {
          phase: "completed",
          artifactAvailable: true,
          outputBytes: artifact.bytes,
          fileCount: artifact.files.length,
          error: null,
        });
        this.report({
          event: this.eventPrefix + ".completed",
          id: job.id,
          files: artifact.files.length,
          bytes: artifact.bytes,
        });
      }
    } catch (error) {
      if (this.closed) return;
      const current = await this.jobs.get(job.id);
      if (terminalBuildRun(current)) return;
      const code = error instanceof SiteBuildError ? error.code : "executorUnavailable";
      if (current.phase === "cancelling" && code === "executorMissing") {
        await this.jobs.update(job.id, { phase: "cancelled", connection: "ready", error: null });
      } else if (
        [
          "executorMissing",
          "executorConflict",
          "executorProtocol",
          "requestExpired",
          "snapshotUnavailable",
          "artifactDigestMismatch",
          "themeNotApproved",
        ].includes(code)
      ) {
        await this.jobs.update(job.id, { phase: "failed", connection: "ready", error: code });
        this.report({ event: this.eventPrefix + ".failed", id: job.id, code });
      } else {
        const count = (this.retries.get(job.id)?.count || 0) + 1;
        this.retries.set(job.id, { count, next: this.now() + Math.min(30000, 2000 * 2 ** Math.min(count, 4)) });
        await this.jobs.update(job.id, {
          connection: "retrying",
          error: code === "inputBusy" ? "inputBusy" : "executorUnavailable",
        });
      }
    }
  }
  stop() {
    this.closed = true;
    this.retention.stop();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  async drain() {
    this.stop();
    await Promise.allSettled(this.flight ? [this.flight] : []);
  }
}
