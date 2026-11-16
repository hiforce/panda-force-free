import type { SitePublicationPlan } from "../../shared/delivery/contracts.js";
import { DeliveryError, PublicationEffectError } from "./errors.js";
import type { MySQLPublicationRepository } from "./mysql-repository.js";
import type { PublicationGate, SiteDeliveryAdapter } from "./ports.js";
import { verifiedArtifact } from "./validation.js";
/** One wake loop per process; MySQL leases arbitrate restarts and competing processes. */
export class MySQLPublicationWorker {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wakePending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private store: MySQLPublicationRepository,
    private adapter: (owner: string, plan: SitePublicationPlan) => SiteDeliveryAdapter,
    private authorize: (
      owner: string,
      plan: SitePublicationPlan,
      checkOnly?: boolean,
    ) => Promise<() => void | Promise<void>>,
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
    await this.store.expire();
    while (!this.stopped) {
      const lease = await this.store.acquire();
      if (!lease) return;
      if (this.stopped) {
        await this.store.releaseLease(lease);
        return;
      }
      let activation = lease.resumed || lease.checkOnly,
        active = true,
        pendingHeartbeat = Promise.resolve();
      const heartbeat = setInterval(() => {
        pendingHeartbeat = pendingHeartbeat
          .then(async () => {
            if (active) await this.store.guard(lease, () => {});
          })
          .catch(() => {
            clearInterval(heartbeat);
          });
      }, 15000);
      heartbeat.unref();
      try {
        const { plan, job } = await this.store.get(lease.id),
          owner = await this.store.owner(lease.id);
        activation ||= job.step === "activating";
        const adapter = this.adapter(owner, plan);
        const inspect = (lease.checkOnly && !lease.cleanup) || (lease.resumed && adapter.recovery === "inspect-only");
        if (inspect) activation = true;
        const assertCurrent = await this.authorize(owner, plan, lease.checkOnly || inspect);
        await assertCurrent();
        const artifact = verifiedArtifact(await this.store.snapshot(plan.id));
        if (inspect) {
          const receipt = await adapter.reconcile(plan, artifact);
          await this.store.finish(
            lease,
            receipt ? "published" : "needsAttention",
            receipt,
            receipt ? null : "outcomeUnknown",
          );
          continue;
        }
        const gate: PublicationGate = {
          fence: lease.fence,
          run: async <T>(step: "staging" | "activating", operation: () => T): Promise<T> => {
            await this.store.step(lease, step);
            if (step === "activating") activation = true;
            return await this.store.guard(lease, async () => {
              await assertCurrent();
              return operation();
            });
          },
          remote: async <T>(step: "staging" | "activating", name: string, operation: () => Promise<T>): Promise<T> => {
            const effect = await this.store.guard(lease, async () => {
              await assertCurrent();
              await this.store.step(lease, step);
              return await this.store.remoteIntent(lease, name);
            });
            activation = true;
            // The network operation is outside the database transaction. Its intent remains unresolved if ownership or the reply is lost.
            const result = await operation();
            await this.store.remoteAcknowledged(lease, effect);
            return result;
          },
        };
        if (lease.cleanup && !adapter.recover) throw new DeliveryError("conflict", 409);
        const receipt = await (lease.cleanup
          ? adapter.recover!(plan, artifact, gate)
          : adapter.deliver(plan, artifact, gate));
        await this.store.finish(lease, "published", receipt, null);
      } catch (error) {
        if (error instanceof DeliveryError && error.code === "leaseLost") continue;
        const code = error instanceof DeliveryError ? error.code : "deliveryFailed";
        try {
          const uncertain = error instanceof PublicationEffectError ? error.outcome === "unknown" : activation;
          await this.store.finish(lease, uncertain ? "needsAttention" : "failed", null, code);
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
