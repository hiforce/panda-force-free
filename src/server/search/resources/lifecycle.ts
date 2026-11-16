import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import { IndexIntegrityError } from "../integrity.js";
import type { IndexReference } from "../ports.js";
import type { IndexResourceRegistry, PhysicalIndexStorage } from "./contracts.js";
import { withIndexResourceLease } from "./lease.js";
/** Own allocation, read leases and final deletion fences without choosing a vector engine or database adapter. */
export class IndexResourceLifecycle {
  constructor(
    readonly registry: MetadataStore<IndexResourceRegistry>,
    readonly storage: PhysicalIndexStorage,
    private dropLocal: (name: string) => Promise<void>,
    private report: (error: unknown) => void,
  ) {}
  async build(
    name: string,
    recipe: string,
    signal: AbortSignal,
    execute: (marker: string, signal: AbortSignal) => Promise<IndexReference>,
  ) {
    const marker = "panda-index/1/" + this.storage.id + "/" + name + "/" + randomUUID(),
      allocation = await this.registry.reserve(this.storage.id, name, recipe, marker),
      ticket = { storage: this.storage.id, name, token: allocation.token! };
    let success = false;
    try {
      const result = await withIndexResourceLease(
        signal,
        async () => await this.registry.heartbeat(ticket),
        async (active) => {
          const reference = await execute(marker, active),
            physical = await this.storage.inspect(name, active);
          if (!physical || !(await this.registry.seal(ticket, physical, reference)))
            throw new IndexIntegrityError("unverified");
          return reference;
        },
      );
      success = true;
      return result;
    } finally {
      await this.registry.release(ticket);
      if (!success) {
        try {
          await this.drop(name, true, AbortSignal.timeout(60000));
        } catch (error) {
          this.report(error);
        }
      }
    }
  }
  async read<T>(name: string, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Legacy resources have no allocation marker. They remain readable but cannot enter owned-resource cleanup.
    if (!(await this.registry.get(this.storage.id, name))) return execute(signal);
    const ticket = await this.registry.pin(this.storage.id, name);
    try {
      return await withIndexResourceLease(
        signal,
        async () => await this.registry.heartbeatRead(ticket),
        async (active) => {
          const physical = await this.storage.inspect(name, active),
            row = await this.registry.observe(this.storage.id, name, physical);
          if (!physical) throw new IndexIntegrityError("missing");
          if (!row || row.state === "unverified") throw new IndexIntegrityError("corrupt");
          return execute(active);
        },
      );
    } finally {
      await this.registry.unpin(ticket);
    }
  }
  async drop(name: string, immediate: boolean, signal: AbortSignal) {
    if (!(await this.registry.get(this.storage.id, name))) return false;
    const physical = await this.storage.inspect(name, signal),
      row = (await this.registry.observe(this.storage.id, name, physical))!;
    if (row.state === "deleted") {
      if (physical || (await this.registry.protected(row))) return false;
      await this.dropLocal(name);
      return true;
    }
    const ticket = await this.registry.claimDrop(this.storage.id, name, physical, immediate);
    if (!ticket) return false;
    const current = await this.storage.inspect(name, signal);
    if (!(await this.registry.mayDrop(ticket, current))) {
      await this.registry.observe(this.storage.id, name, current);
      return false;
    }
    signal.throwIfAborted();
    if (current) await this.storage.remove(name, signal);
    const remaining = await this.storage.inspect(name, signal);
    if (remaining || !(await this.registry.mayDrop(ticket, null))) {
      await this.registry.observe(this.storage.id, name, remaining);
      throw new SearchError("conflict", 409);
    }
    await this.dropLocal(name);
    if (!(await this.registry.deleted(ticket))) throw new SearchError("conflict", 409);
    return true;
  }
}
