import type { RunBudgetClock } from "../../src/server/engines/active-budget.js";

export class ManualRunClock implements RunBudgetClock {
  private time = 0;
  private sequence = 0;
  private readonly scheduled = new Map<number, { at: number; run(): void }>();
  now() {
    return this.time;
  }
  schedule(run: () => void, delay: number) {
    const id = ++this.sequence;
    this.scheduled.set(id, { at: this.time + delay, run });
    return () => {
      this.scheduled.delete(id);
    };
  }
  advance(duration: number) {
    const end = this.time + duration;
    while (true) {
      const next = [...this.scheduled.entries()]
        .filter(([, value]) => value.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.scheduled.delete(next[0]);
      this.time = next[1].at;
      next[1].run();
    }
    this.time = end;
  }
}
