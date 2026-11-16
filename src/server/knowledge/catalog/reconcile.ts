import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTaskFiles, KnowledgeContent } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { KnowledgeAdmission, KnowledgeCatalog } from "./contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
/** Rebuilds derived metadata from completed delivery and immutable files; never approves, regenerates or rewrites knowledge. */
export class KnowledgeCatalogReconciler {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private rerun = false;
  private cursors = ["", ""];
  private requested = new Map<string, KnowledgeAdmission>();
  private failures = new Map<
    string,
    {
      attempts: number;
      after: number;
    }
  >();
  constructor(
    private catalog: MetadataStore<KnowledgeCatalog>,
    private files: KnowledgeTaskFiles,
    private content: KnowledgeContent,
    private report: (error: unknown) => void,
    private now = Date.now,
  ) {}
  request(admissions: readonly KnowledgeAdmission[]) {
    for (const accepted of admissions) {
      if (this.requested.size >= 256 && !this.requested.has(accepted.taskId)) break;
      this.requested.set(accepted.taskId, accepted);
    }
    if (admissions.length) this.rerun = true;
    this.kick();
  }
  start() {
    if (this.closing || this.timer) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
  }
  kick() {
    if (this.closing || this.running || !this.content.projection) return;
    this.rerun = false;
    this.running = this.drain()
      .catch(this.report)
      .finally(() => {
        this.running = null;
        if (this.rerun && !this.closing) this.kick();
      });
  }
  private async drain() {
    let performed = 0;
    const manual = new Map(this.requested),
      candidates = new Map(manual);
    this.requested.clear();
    for (const kind of [0, 1]) {
      const batch = await this.catalog.candidates(this.cursors[kind]!, kind === 0);
      this.cursors[kind] = batch.cursor;
      if (batch.invalid) this.report(new KnowledgeTaskError("unavailable"));
      for (const accepted of batch.admissions) candidates.set(accepted.taskId, accepted);
    }
    for (const accepted of candidates.values()) {
      if (this.closing) return;
      if (performed >= 4) {
        if (manual.has(accepted.taskId) && this.requested.size < 256) this.requested.set(accepted.taskId, accepted);
        continue;
      }
      const failed = this.failures.get(accepted.taskId);
      if ((await this.catalog.current(accepted)) || (failed && failed.after > this.now())) continue;
      performed++;
      try {
        const [input, record] = await Promise.all([
          this.files.input(accepted.inputDigest),
          this.files.output(accepted.outputDigest),
        ]);
        if (
          input.scope.project !== accepted.project ||
          record.taskId !== accepted.taskId ||
          record.id !== accepted.receipt.id ||
          record.version !== accepted.receipt.version
        )
          throw new KnowledgeTaskError("conflict");
        const recovered = await this.content.recover?.(accepted.owner, input, record);
        if (recovered && stableJson(recovered.receipt) !== stableJson(accepted.receipt))
          throw new KnowledgeTaskError("conflict");
        const projection =
          recovered?.projection ?? (await this.content.projection!(accepted.owner, input, record, accepted.receipt));
        if (!(await this.catalog.save(accepted, projection))) throw new KnowledgeTaskError("conflict");
        this.failures.delete(accepted.taskId);
      } catch (error) {
        const attempts = Math.min(10, (failed?.attempts ?? 0) + 1);
        this.failures.set(accepted.taskId, { attempts, after: this.now() + Math.min(1800000, 30000 * 2 ** attempts) });
        while (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
        this.report(error);
      }
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.running;
  }
}
