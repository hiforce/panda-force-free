import type { BuildRetentionStoreMetadata } from "./runtime/ports.js";
import type { SiteBuildArtifacts } from "./artifacts.js";
import { artifactStorageBudget } from "./runtime/budget.js";
export { artifactStorageBudget };
/** Generated files have a bounded lifetime; source revisions and execution receipts stay independent. */
export class SiteBuildRetention {
  private closed = false;
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private jobs: BuildRetentionStoreMetadata,
    private artifacts: SiteBuildArtifacts,
  ) {}
  prune(reservedBytes = 0): Promise<void> {
    const pending = this.serial.then(() => this.apply(reservedBytes));
    this.serial = pending.catch(() => {});
    return pending;
  }
  private async apply(reservedBytes: number) {
    if (this.closed) return;
    let size = reservedBytes,
      count = reservedBytes ? 1 : 0;
    for (const job of await this.jobs.artifacts()) {
      if (this.closed) return;
      // Include base64 and worst-case path/manifest overhead in the shared disk budget.
      size += artifactStorageBudget(job.outputBytes, job.fileCount);
      count++;
      if (count <= 50 && size <= 512 * 1024 * 1024 && Date.now() - job.createdAt < 14 * 86400000) continue;
      await this.jobs.update(job.id, { artifactAvailable: false });
      await this.artifacts.remove(job.id);
    }
    if (!this.closed) {
      const keep = new Set([...(await this.jobs.active()), ...(await this.jobs.artifacts())].map((job) => job.id));
      if (!this.closed) await this.artifacts.sweep(keep);
    }
  }
  stop() {
    this.closed = true;
  }
  async drain() {
    this.stop();
    await this.serial;
  }
}
