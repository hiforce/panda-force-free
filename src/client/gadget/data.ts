/** A shared request budget prevents independently registered gadgets from multiplying traffic. */
export class GadgetDataBudget {
  private active = 0;
  private waiting: Array<() => void> = [];
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const queued = this.active >= 4;
    if (queued)
      await new Promise<void>((resolve, reject) => {
        const next = () => {
          signal.removeEventListener("abort", cancel);
          this.active++;
          resolve();
        };
        const cancel = () => {
          this.waiting = this.waiting.filter((x) => x !== next);
          reject(new DOMException("Aborted", "AbortError"));
        };
        this.waiting.push(next);
        signal.addEventListener("abort", cancel, { once: true });
      });
    if (!queued) this.active++;
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
  read(key: string, seconds: number, signal: AbortSignal, work: () => Promise<unknown>) {
    const old = this.cache.get(key);
    if (old && old.expires > Date.now()) return old.value;
    const entry = { expires: Date.now() + Math.max(60, seconds) * 1000, value: this.run(signal, work) };
    this.cache.set(key, entry);
    void entry.value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return entry.value;
  }
  invalidate(prefix: string) {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }
}
