export interface RunBudgetClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
const systemClock: RunBudgetClock = {
  now: () => performance.now(),
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Only active engine time consumes this budget; nested user interactions hold it without resetting it. */
export class ActiveRunBudget {
  private remaining: number;
  private started = 0;
  private holds = 0;
  private closed = false;
  private cancel: (() => void) | null = null;
  constructor(
    duration: number,
    private readonly exhausted: () => void,
    private readonly clock: RunBudgetClock = systemClock,
  ) {
    if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("Invalid active run budget");
    this.remaining = duration;
    this.arm();
  }
  private arm() {
    if (this.closed || this.holds) return;
    this.started = this.clock.now();
    this.cancel = this.clock.schedule(
      () => {
        this.cancel = null;
        this.closed = true;
        this.exhausted();
      },
      Math.max(0, this.remaining),
    );
  }
  hold() {
    if (this.closed) return () => {};
    if (!this.holds++) {
      this.remaining = Math.max(0, this.remaining - Math.max(0, this.clock.now() - this.started));
      this.cancel?.();
      this.cancel = null;
    }
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      if (!--this.holds) this.arm();
    };
  }
  close() {
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }
}
