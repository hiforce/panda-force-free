export class RenderingBusyError extends Error {}
interface Waiter {
  signal: AbortSignal;
  enter(): void;
  cancel(): void;
}
/** Expensive render work is bounded across all owners; cancelled waiters never start or consume an active slot. */
export class CreationRenderingSlots {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  constructor(
    private readonly maximum = 2,
    private readonly queued = 16,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 16 ||
      !Number.isSafeInteger(queued) ||
      queued < 0 ||
      queued > 64
    )
      throw new RenderingBusyError("invalidLimit");
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.maximum) {
      if (this.waiting.length >= this.queued) throw new RenderingBusyError("busy");
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          signal,
          enter: () => {
            signal.removeEventListener("abort", waiter.cancel);
            resolve();
          },
          cancel: () => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            signal.removeEventListener("abort", waiter.cancel);
            reject(signal.reason);
          },
        };
        this.waiting.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        if (signal.aborted) waiter.cancel();
      });
    } else this.active++;
    try {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      return result;
    } finally {
      const next = this.waiting.shift();
      if (next) next.enter();
      else this.active--;
    }
  }
}
export const creationRenderSlots = new CreationRenderingSlots();
export const creationArtifactSaveSlots = new CreationRenderingSlots();
