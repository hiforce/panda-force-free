import { createLifecycle } from "../lifecycle.js";

/** Owns a settings mount's cancellation and timers; drafts and uncertain receipts stay feature-owned. */
export class SettingsPageLifetime {
  private controller = new AbortController();
  private resources = createLifecycle();
  private revision = 0;
  get epoch() {
    return this.revision;
  }
  get signal() {
    return this.controller.signal;
  }
  invalidate() {
    this.revision++;
    this.controller.abort();
    this.resources.dispose();
  }
  renew() {
    this.controller = new AbortController();
    this.resources = createLifecycle();
  }
  timeout(callback: () => void, milliseconds: number) {
    const epoch = this.epoch;
    return this.resources.timeout(() => {
      if (this.epoch === epoch && !this.signal.aborted) callback();
    }, milliseconds);
  }
  interval(callback: () => void, milliseconds: number) {
    const epoch = this.epoch;
    return this.resources.interval(() => {
      if (this.epoch === epoch && !this.signal.aborted) callback();
    }, milliseconds);
  }
}
