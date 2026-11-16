import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTaskStore } from "./contracts.js";
import type { KnowledgeWorker } from "./worker.js";
import type { KnowledgeOutputs } from "./outputs.js";
import type { KnowledgeReviewStore } from "../review/contracts.js";
import type { KnowledgeAutomaticReviewer } from "../review/worker.js";
import type { KnowledgeApprovals } from "./approvals.js";
import type { KnowledgeAccessScope } from "./access.js";
/** Background knowledge defaults to one bounded execution, leaving foreground conversations independent. */
export class KnowledgeRunner {
  private readonly active = new Map<
    string,
    {
      owner: string;
      project: string;
      review: boolean;
      controller: AbortController;
      work: Promise<void>;
    }
  >();
  private interval: ReturnType<typeof setInterval> | undefined;
  private queued: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | null = null;
  private closing = false;
  private started = false;
  private again = false;
  private maintenance: (() => Promise<void>) | undefined;
  constructor(
    private readonly ledger: Pick<MetadataStore<KnowledgeTaskStore>, "claim" | "nextOutput" | "release">,
    private readonly worker: KnowledgeWorker,
    private readonly outputs: KnowledgeOutputs,
    private readonly enabled: () => boolean,
    private readonly report: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly concurrency = 1,
    private readonly automatic?: {
      store: Pick<MetadataStore<KnowledgeReviewStore>, "claim" | "pending" | "fail">;
      worker: KnowledgeAutomaticReviewer;
      approvals: KnowledgeApprovals;
    },
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2)
      throw new Error("Invalid knowledge concurrency");
  }
  start() {
    if (this.started || this.closing) return;
    this.started = true;
    this.interval = setInterval(() => this.wake(), 1000);
    this.interval.unref();
    this.wake();
  }
  wake() {
    if (!this.started || this.closing || this.queued) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.queued = setTimeout(() => {
      this.queued = undefined;
      this.pumping = this.pump()
        .catch(this.report)
        .finally(() => {
          this.pumping = null;
          if (this.again) {
            this.again = false;
            this.wake();
          }
        });
    }, 0);
    this.queued.unref();
  }
  private async pump() {
    await this.maintenance?.();
    const output = await this.ledger.nextOutput(this.now());
    if (output) await this.outputs.reconcile(output.owner, output.id).catch(this.report);
    if (this.automatic) {
      const reviewed = await this.automatic.store.pending();
      if (reviewed)
        await this.automatic.approvals.automatic(reviewed).catch(async (error) => {
          await this.automatic!.store.fail(reviewed, this.now());
          this.report(error);
        });
    }
    while (!this.closing && this.enabled() && this.active.size < this.concurrency) {
      const review = await this.automatic?.store.claim(this.now());
      if (review) {
        if (this.closing || !this.enabled()) {
          await this.automatic!.store.fail(review.review, this.now());
          break;
        }
        const controller = new AbortController(),
          work = this.automatic!.worker.run(review.review, controller.signal)
            .catch(this.report)
            .finally(() => {
              this.active.delete(review.task.id);
              this.wake();
            });
        this.active.set(review.task.id, {
          owner: review.task.owner,
          project: review.task.project,
          review: true,
          controller,
          work,
        });
        continue;
      }
      const claim = await this.ledger.claim(this.now(), 30000);
      if (!claim) break;
      if (this.closing || !this.enabled()) {
        await this.ledger.release(claim.lease, this.now());
        break;
      }
      const controller = new AbortController(),
        work = this.worker
          .run(claim, controller.signal)
          .catch(this.report)
          .finally(() => {
            this.active.delete(claim.task.id);
            this.wake();
          });
      this.active.set(claim.task.id, {
        owner: claim.lease.owner,
        project: claim.task.project,
        review: false,
        controller,
        work,
      });
    }
  }
  interrupt(owner: string, id: string) {
    const active = this.active.get(id);
    if (active?.owner === owner) active.controller.abort(new Error("Knowledge task cancelled"));
  }
  maintain(work: () => Promise<void>) {
    this.maintenance = work;
  }
  scopes(): KnowledgeAccessScope[] {
    return [...this.active.values()].map(({ owner, project }) => ({ owner, project }));
  }
  interruptScope(owner: string, project: string) {
    for (const active of this.active.values())
      if (active.owner === owner && active.project === project)
        active.controller.abort(new Error("Knowledge scope authorization changed"));
  }
  reviewChanged(owner: string, project: string) {
    for (const active of this.active.values())
      if (active.review && active.owner === owner && active.project === project)
        active.controller.abort(new Error("Automatic review policy changed"));
    this.wake();
  }
  async close() {
    this.closing = true;
    clearInterval(this.interval);
    clearTimeout(this.queued);
    for (const active of this.active.values()) active.controller.abort(new Error("Knowledge runtime stopping"));
    await this.pumping;
    await Promise.allSettled([...this.active.values()].map((active) => active.work));
    await this.outputs.drain();
  }
}
