import { PackageContentError } from "./file-bytes.js";

export interface NamespaceActivity {
  read<T>(id: string, work: () => Promise<T>): Promise<T>;
  write(id: string, work: () => Promise<void>): Promise<void>;
  remove(id: string, work: () => Promise<void>): Promise<void>;
}

/** One file owner drains both fulfilled and rejected IO before removing an immutable namespace. */
export class LocalNamespaceActivity implements NamespaceActivity {
  private uses = new Map<string, Set<Promise<unknown>>>();
  private removals = new Map<string, Promise<void>>();
  constructor(private conflict: () => Error = () => new PackageContentError("contentChanged")) {}
  write(id: string, work: () => Promise<void>) {
    return this.read(id, work);
  }
  read<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.removals.has(id)) return Promise.reject(this.conflict());
    const active = this.uses.get(id) ?? new Set<Promise<unknown>>();
    this.uses.set(id, active);
    const pending = Promise.resolve().then(work);
    active.add(pending);
    return pending.finally(() => {
      active.delete(pending);
      if (!active.size) this.uses.delete(id);
    });
  }
  remove(id: string, work: () => Promise<void>): Promise<void> {
    const existing = this.removals.get(id),
      pending = Promise.resolve().then(async () => {
        if (existing) await Promise.allSettled([existing]);
        await Promise.allSettled([...(this.uses.get(id) ?? [])]);
        await work();
      });
    this.removals.set(id, pending);
    return pending.finally(() => {
      if (this.removals.get(id) === pending) this.removals.delete(id);
    });
  }
}
