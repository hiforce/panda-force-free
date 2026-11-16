/** Coalesces typing snapshots with a bounded recovery delay; explicit transitions always flush synchronously. */
export class TemplateCaptureQueue {
  private idle: ReturnType<typeof setTimeout> | null = null;
  private maximum: ReturnType<typeof setTimeout> | null = null;
  pending = false;
  constructor(
    private capture: () => boolean,
    private changed: () => void,
  ) {}
  schedule() {
    if (this.idle) clearTimeout(this.idle);
    const first = !this.pending;
    this.pending = true;
    this.idle = setTimeout(() => this.flush(), 180);
    this.maximum ||= setTimeout(() => this.flush(), 900);
    if (first) this.changed();
  }
  flush() {
    this.clear();
    return this.capture();
  }
  clear() {
    if (this.idle) clearTimeout(this.idle);
    if (this.maximum) clearTimeout(this.maximum);
    this.idle = this.maximum = null;
    this.pending = false;
  }
}
