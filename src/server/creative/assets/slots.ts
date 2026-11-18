import { DocumentError } from "../../documents/errors.js";
interface Waiting {
  owner: string;
  signal: AbortSignal;
  abort(): void;
  resolve(release: () => void): void;
  reject(error: DocumentError): void;
}
/** Bound memory and provider IO while allowing ordinary parallel browser requests to wait instead of failing a short burst. */
export class CreativeAssetSlots {
  private total = 0;
  private readonly active = new Map<string, number>();
  private readonly waiting: Waiting[] = [];
  acquire(owner: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DocumentError("unavailable", 503));
    if (this.available(owner)) return Promise.resolve(this.activate(owner));
    if (this.waiting.length >= 24 || this.waiting.filter((entry) => entry.owner === owner).length >= 12)
      return Promise.reject(new DocumentError("busy", 429));
    return new Promise((resolve, reject) => {
      const entry: Waiting = {
        owner,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal.removeEventListener("abort", entry.abort);
          reject(new DocumentError("unavailable", 503));
          this.pump();
        },
      };
      this.waiting.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      if (signal.aborted) entry.abort();
    });
  }
  private available(owner: string) {
    return this.total < 4 && (this.active.get(owner) ?? 0) < 2;
  }
  private activate(owner: string) {
    this.total++;
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const count = this.active.get(owner)! - 1;
      if (count) this.active.set(owner, count);
      else this.active.delete(owner);
      this.pump();
    };
  }
  private pump() {
    while (this.total < 4) {
      const index = this.waiting.findIndex((entry) => this.available(entry.owner));
      if (index < 0) return;
      const entry = this.waiting.splice(index, 1)[0]!;
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) entry.reject(new DocumentError("unavailable", 503));
      else entry.resolve(this.activate(entry.owner));
    }
  }
}
