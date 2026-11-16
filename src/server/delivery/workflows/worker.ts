import type { WorkflowRepository } from "../storage/workflows.js";
import type { WorkflowHandler } from "./ports.js";
import { DeliveryError } from "../errors.js";
import { WorkflowDeferred } from "./errors.js";
import { workflowEffects } from "./effects.js";

/** Executes one workflow kind. Site jobs and other connector workflows have independent leases. */
export class WorkflowWorker {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wakePending = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private store: WorkflowRepository,
    private handler: WorkflowHandler,
    private report: (code: string) => void,
  ) {
    this.timer = setInterval(() => this.wake(), 5000);
    this.timer.unref();
  }
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    this.running = this.drain()
      .catch(() => this.report("workerUnavailable"))
      .finally(() => {
        this.running = null;
        if (this.wakePending) {
          this.wakePending = false;
          this.wake();
        }
      });
  }
  async idle() {
    while (this.running) await this.running;
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  private async drain() {
    while (!this.stopped) {
      const lease = this.store.leases.acquire();
      if (!lease) return;
      const { plan } = this.store.get(lease.id),
        owner = this.store.owner(lease.id);
      const heartbeat = setInterval(() => {
        try {
          this.store.leases.guard(lease, () => {});
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      heartbeat.unref();
      try {
        this.store.cancellations.assertContinuing(lease.id);
        const authorization = await this.handler.authorize(owner, plan);
        const effects = workflowEffects(this.store, this.handler, owner, plan, lease, authorization);
        const receipt = await this.handler.execute(owner, plan, effects);
        this.store.finish(lease, "completed", receipt, null);
      } catch (error) {
        if (error instanceof DeliveryError && error.code === "leaseLost") continue;
        let failure = error;
        if (error instanceof WorkflowDeferred) {
          try {
            this.store.wait(lease, error.until);
            continue;
          } catch (waitError) {
            failure = waitError;
          }
        }
        const code =
          failure instanceof DeliveryError && /^[a-z][a-zA-Z0-9]{0,80}$/.test(failure.code)
            ? failure.code
            : "deliveryFailed";
        try {
          const pending = this.store.steps.effective(lease.id).some((step) => step.outcome === "pending");
          this.store.finish(lease, pending ? "needsAttention" : "failed", null, code);
        } catch {
          this.report("leaseLost");
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}
