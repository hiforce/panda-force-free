import type { CreationRunPermit } from "./contracts.js";

interface Waiter {
  grant(): void;
}
/** Waiting questions release inference capacity. Answered runs reacquire it in FIFO order before the model continues. */
export class CreationRunSlots {
  private held = 0;
  private waiters: Waiter[] = [];
  constructor(
    private readonly capacity: number,
    private readonly changed: () => void = () => {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8)
      throw new Error("Invalid creation concurrency");
  }
  get available() {
    return this.held < this.capacity && !this.waiters.length;
  }
  private released() {
    this.held--;
    while (this.held < this.capacity && this.waiters.length) this.waiters.shift()!.grant();
    this.changed();
  }
  reserve(): CreationRunPermit | null {
    if (!this.available) return null;
    this.held++;
    let state: "held" | "suspended" | "waiting" | "closed" = "held";
    let pending: Promise<void> | null = null,
      rejectWaiting: ((error: unknown) => void) | null = null;
    const suspend = () => {
      if (state !== "held") return;
      state = "suspended";
      this.released();
    };
    return {
      suspend,
      resume: (signal) => {
        signal.throwIfAborted();
        if (state === "closed") return Promise.reject(new Error("Creation permit closed"));
        if (state === "held") return Promise.resolve();
        if (pending) return pending;
        state = "waiting";
        pending = new Promise<void>((resolve, reject) => {
          const remove = () => {
              const index = this.waiters.indexOf(waiter);
              if (index >= 0) this.waiters.splice(index, 1);
              signal.removeEventListener("abort", abort);
              rejectWaiting = null;
            },
            abort = () => {
              remove();
              state = "suspended";
              pending = null;
              reject(signal.reason);
              this.changed();
            },
            waiter: Waiter = {
              grant: () => {
                remove();
                this.held++;
                state = "held";
                pending = null;
                resolve();
              },
            };
          rejectWaiting = (error) => {
            remove();
            reject(error);
          };
          signal.addEventListener("abort", abort, { once: true });
          this.waiters.push(waiter);
          if (signal.aborted) abort();
          else
            queueMicrotask(() => {
              while (this.held < this.capacity && this.waiters.length) this.waiters.shift()!.grant();
            });
        });
        return pending;
      },
      close: () => {
        if (state === "closed") return;
        const held = state === "held";
        state = "closed";
        rejectWaiting?.(new Error("Creation permit closed"));
        pending = null;
        if (held) this.released();
        else this.changed();
      },
    };
  }
}
