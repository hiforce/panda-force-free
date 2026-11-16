import { DeliveryError } from "../errors.js";
import type { MySQLWorkflowRepository } from "../storage/mysql-workflows.js";
import type { AsyncWorkflowHandler } from "./async-ports.js";
import { WorkflowDeferred } from "./errors.js";
import { mysqlWorkflowEffects } from "./mysql-effects.js";
/** Executes one workflow kind. Site jobs and other connector workflows have independent leases. */
export class MySQLWorkflowWorker {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wakePending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private store: MySQLWorkflowRepository,
    private handler: AsyncWorkflowHandler,
    private report: (code: string) => void,
  ) {}
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), 5000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    this.running = this.drain()
      .catch(async () => await this.report("workerUnavailable"))
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
      const lease = await this.store.leases.acquire();
      if (!lease) return;
      if (this.stopped) {
        await this.store.leases.release(lease);
        return;
      }
      let active = true,
        pendingHeartbeat = Promise.resolve();
      const heartbeat = setInterval(() => {
        pendingHeartbeat = pendingHeartbeat
          .then(async () => {
            if (active) await this.store.leases.guard(lease, () => {});
          })
          .catch(() => {
            clearInterval(heartbeat);
          });
      }, 15000);
      heartbeat.unref();
      try {
        const { plan } = await this.store.get(lease.id),
          owner = await this.store.owner(lease.id);
        await this.store.cancellations.assertContinuing(lease.id);
        const authorization = await this.handler.authorize(owner, plan);
        const effects = await mysqlWorkflowEffects(this.store, this.handler, owner, plan, lease, authorization);
        const receipt = await this.handler.execute(owner, plan, effects);
        await this.store.finish(lease, "completed", receipt, null);
      } catch (error) {
        if (error instanceof DeliveryError && error.code === "leaseLost") continue;
        let failure = error;
        if (error instanceof WorkflowDeferred) {
          try {
            await this.store.wait(lease, error.until);
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
          const pending = (await this.store.steps.effective(lease.id)).some((step) => step.outcome === "pending");
          await this.store.finish(lease, pending ? "needsAttention" : "failed", null, code);
        } catch {
          await this.report("leaseLost");
        }
      } finally {
        active = false;
        clearInterval(heartbeat);
        await pendingHeartbeat;
      }
    }
  }
}
