import type { KnowledgeGenerationDiscovery } from "./discovery.js";
import type { KnowledgeGenerationSubmission } from "./submission.js";

/** Lifetime coordination is independent of source scanning, policy decisions and transactional task admission. */
export class KnowledgeGenerationWorker {
  private interval: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | null = null;
  private shutdown = new AbortController();
  constructor(
    private discovery: Pick<KnowledgeGenerationDiscovery, "scan">,
    private submission: Pick<KnowledgeGenerationSubmission, "run">,
    private enabled: () => boolean,
    private report: (error: unknown) => void,
    private maintenance: () => boolean | Promise<boolean> = () => true,
  ) {}
  start() {
    if (this.interval || this.shutdown.signal.aborted) return;
    this.interval = setInterval(() => this.wake(), 2000);
    this.interval.unref();
    this.wake();
  }
  wake() {
    if (!this.interval || this.shutdown.signal.aborted || this.work) return;
    void this.tick().catch(this.report);
  }
  tick(): Promise<void> {
    if (this.work) return this.work;
    this.work = this.pump().finally(() => {
      this.work = null;
    });
    return this.work;
  }
  private async pump() {
    if (this.shutdown.signal.aborted || !(await this.maintenance()) || !this.enabled()) return;
    await this.discovery.scan(this.shutdown.signal);
    if (!this.shutdown.signal.aborted) await this.submission.run(this.shutdown.signal).catch(this.report);
  }
  async close() {
    this.shutdown.abort();
    clearInterval(this.interval);
    await this.work;
  }
}
