import type { CreationScheduling } from "./contracts.js";
import type { CreationOutputs } from "../outputs.js";
import type { CreationWorker } from "./worker.js";
import { CreationRunSlots } from "./slots.js";

/** Scheduling owns process lifetime and bounded inference slots; workers own a single execution's authority. */
export class CreationRunner {
  private readonly slots: CreationRunSlots;
  private readonly active = new Map<AbortController, { owner: string; id: string; work: Promise<void> }>();
  private closing = false;
  private running = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private wakeup: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | null = null;
  private again = false;
  constructor(
    private readonly queue: CreationScheduling,
    private readonly worker: CreationWorker,
    private readonly outputs: Pick<CreationOutputs, "reconcile">,
    private readonly diagnostic: (stage: "run" | "schedule" | "recovery", error: unknown) => void,
    private readonly now: () => number = Date.now,
    concurrency = 2,
    private readonly canRun: () => boolean = () => true,
  ) {
    this.slots = new CreationRunSlots(concurrency, () => this.wake());
  }
  start() {
    if (this.running || this.closing) return;
    this.running = true;
    this.interval = setInterval(() => this.wake(), 1000);
    this.interval.unref();
    this.wake();
  }
  wake() {
    if (!this.running || this.closing || this.wakeup) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      if (this.pumping || this.closing) return;
      this.pumping = this.pump()
        .catch((error) => this.diagnostic("schedule", error))
        .finally(() => {
          this.pumping = null;
          if (this.again) {
            this.again = false;
            this.wake();
          }
        });
    }, 0);
    this.wakeup.unref();
  }
  private async pump() {
    const recovery = await this.queue.nextOutput(this.now());
    if (recovery) {
      try {
        await this.outputs.reconcile(recovery.spec.owner, recovery.spec.id);
      } catch (error) {
        this.diagnostic("recovery", error);
      }
    }
    while (!this.closing && this.canRun() && this.slots.available && this.active.size < 32) {
      const permit = this.slots.reserve();
      if (!permit) break;
      let claim: Awaited<ReturnType<CreationScheduling["claim"]>>;
      try {
        claim = await this.queue.claim(this.now());
      } catch (error) {
        permit.close();
        throw error;
      }
      if (!claim) {
        permit.close();
        break;
      }
      if (this.closing) {
        await this.queue.release(claim.lease, this.now());
        permit.close();
        break;
      }
      const controller = new AbortController(),
        work = this.worker
          .run(claim, controller.signal, permit)
          .catch((error) => this.diagnostic("run", error))
          .finally(() => {
            this.active.delete(controller);
            this.wake();
          });
      this.active.set(controller, { work, owner: claim.lease.owner, id: claim.lease.taskId });
    }
  }
  interrupt(owner: string, id: string) {
    for (const [controller, active] of this.active)
      if (active.owner === owner && active.id === id) controller.abort(new Error("Creation task cancelled"));
  }
  async stop() {
    this.closing = true;
    clearInterval(this.interval);
    clearTimeout(this.wakeup);
    for (const controller of this.active.keys()) controller.abort(new Error("Creation runtime stopping"));
    await this.pumping;
    await Promise.allSettled([...this.active.values()].map((active) => active.work));
  }
}
