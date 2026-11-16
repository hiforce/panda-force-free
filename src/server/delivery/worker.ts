import type { SiteDeliveryAdapter, PublicationGate } from "./ports.js";
import type { PublicationRepository } from "./repository.js";
import type { SitePublicationPlan } from "../../shared/delivery/contracts.js";
import { DeliveryError, PublicationEffectError } from "./errors.js";
import { verifiedArtifact } from "./validation.js";

/** One wake loop per process; SQLite leases arbitrate restarts and competing processes. */
export class PublicationWorker {
  private running: Promise<void> | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private store: PublicationRepository,
    private adapter: (owner: string, plan: SitePublicationPlan) => SiteDeliveryAdapter,
    private authorize: (owner: string, plan: SitePublicationPlan, checkOnly?: boolean) => Promise<() => void>,
    private report: (code: string) => void,
  ) {
    this.timer = setInterval(() => this.wake(), 5000);
    this.timer.unref();
  }
  wake() {
    if (this.stopped || this.running) return;
    this.running = this.drain()
      .catch(() => this.report("workerUnavailable"))
      .finally(() => {
        this.running = null;
      });
  }
  async idle() {
    await this.running;
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  private async drain() {
    this.store.expire();
    while (!this.stopped) {
      const lease = this.store.acquire();
      if (!lease) return;
      const { plan, job } = this.store.get(lease.id),
        owner = this.store.owner(lease.id);
      let activation = job.step === "activating" || lease.checkOnly;
      const heartbeat = setInterval(() => {
        try {
          this.store.guard(lease, () => {});
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      heartbeat.unref();
      try {
        const adapter = this.adapter(owner, plan);
        const inspect = (lease.checkOnly && !lease.cleanup) || (lease.resumed && adapter.recovery === "inspect-only");
        if (inspect) activation = true;
        const assertCurrent = await this.authorize(owner, plan, lease.checkOnly || inspect);
        assertCurrent();
        const artifact = verifiedArtifact(this.store.snapshot(plan.id));
        if (inspect) {
          const receipt = await adapter.reconcile(plan, artifact);
          this.store.finish(
            lease,
            receipt ? "published" : "needsAttention",
            receipt,
            receipt ? null : "outcomeUnknown",
          );
          continue;
        }
        const gate: PublicationGate = {
          fence: lease.fence,
          run: <T>(step: "staging" | "activating", operation: () => T): T => {
            this.store.step(lease, step);
            if (step === "activating") activation = true;
            return this.store.guard(lease, () => {
              assertCurrent();
              return operation();
            });
          },
          remote: async <T>(step: "staging" | "activating", name: string, operation: () => Promise<T>): Promise<T> => {
            const effect = this.store.guard(lease, () => {
              assertCurrent();
              this.store.step(lease, step);
              return this.store.remoteIntent(lease, name);
            });
            activation = true;
            // The network operation is outside SQLite. Its intent remains unresolved if ownership or the reply is lost.
            const result = await operation();
            this.store.remoteAcknowledged(lease, effect);
            return result;
          },
        };
        if (lease.cleanup && !adapter.recover) throw new DeliveryError("conflict", 409);
        const receipt = await (lease.cleanup
          ? adapter.recover!(plan, artifact, gate)
          : adapter.deliver(plan, artifact, gate));
        this.store.finish(lease, "published", receipt, null);
      } catch (error) {
        if (error instanceof DeliveryError && error.code === "leaseLost") continue;
        const code = error instanceof DeliveryError ? error.code : "deliveryFailed";
        try {
          const uncertain = error instanceof PublicationEffectError ? error.outcome === "unknown" : activation;
          this.store.finish(lease, uncertain ? "needsAttention" : "failed", null, code);
        } catch {
          this.report("leaseLost");
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}
