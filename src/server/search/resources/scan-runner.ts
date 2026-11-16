import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { SearchError } from "../../../shared/search/contracts.js";
import type { ResourceScanStore, ResourceScanTarget } from "./scan-contracts.js";
import { reconcileIndexResources } from "./inventory.js";
import { withIndexResourceLease } from "./lease.js";
/** A serial, fair storage worker resumes durable batches without using model or ordinary conversation capacity. */
export class ResourceScanRunner {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private again: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  private closing = false;
  private cursor = 0;
  private requested = false;
  constructor(
    private scans: MetadataStore<ResourceScanStore>,
    private targets: () => ResourceScanTarget[] | Promise<ResourceScanTarget[]>,
    private report: (error: unknown) => void,
  ) {}
  start() {
    if (this.timer || this.closing) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
  }
  kick() {
    if (this.closing) return;
    this.requested = true;
    if (this.running) return;
    this.requested = false;
    this.running = this.drain()
      .catch(this.report)
      .finally(() => {
        this.running = null;
        if (this.requested && !this.closing) this.kick();
      });
  }
  private async drain() {
    const groups = new Map<string, ResourceScanTarget[]>(),
      priority = (target: ResourceScanTarget) => (target.preferred ? 2 : 0) + (target.automatic ? 1 : 0);
    for (const target of await this.targets()) {
      const storage = target.owner.storage.id;
      groups.set(storage, [...(groups.get(storage) ?? []), target]);
    }
    const targets = [...groups.values()].map((group) => group.sort((a, b) => priority(b) - priority(a)));
    let performed = 0,
      pending = false;
    for (let visited = 0; visited < targets.length && performed < 2 && !this.closing; visited++) {
      const group = targets[this.cursor++ % targets.length]!,
        fallback = group[0]!,
        ticket = await this.scans.claim(fallback.owner.storage.id, fallback.automatic);
      if (!ticket) continue;
      if (this.closing) return;
      performed++;
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 60000);
      this.controller = controller;
      try {
        const selected = await this.scans.connection?.(ticket.storage),
          target = selected ? group.find((entry) => entry.connection === selected) : fallback;
        if (!target) throw new SearchError("configuration", 409);
        const batch = await withIndexResourceLease(
          controller.signal,
          async () => await this.scans.heartbeat(ticket),
          (signal) => reconcileIndexResources(target.owner, ticket.cursor, signal, this.report),
        );
        if (await this.scans.finish(ticket, batch.next, batch.observations))
          pending ||= batch.next.physical !== null || batch.next.allocations !== null;
      } catch (error) {
        if (!this.closing)
          await this.scans.fail(
            ticket,
            error instanceof SearchError && ["forbidden", "limit", "configuration"].includes(error.code)
              ? (error.code as "forbidden" | "limit" | "configuration")
              : "unavailable",
          );
        if (!this.closing) this.report(error);
      } finally {
        clearTimeout(timeout);
        this.controller = null;
      }
    }
    if (pending && !this.closing) {
      clearTimeout(this.again);
      this.again = setTimeout(() => this.kick(), 250);
      this.again.unref();
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    clearTimeout(this.again);
    this.controller?.abort();
    await this.running;
  }
}
