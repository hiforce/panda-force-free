/** This process scope owns only in-flight work; durable receipts and source leases remain authoritative. */
export class CommandScope {
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private commands = new Map<string, { signature: string; result: Promise<unknown> }>();
  constructor(
    private error: (code: "unavailable" | "conflict" | "busy") => Error,
    private limit = 2,
  ) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.error("unavailable"));
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  command<T>(key: string, signature: string, work: () => Promise<T>): Promise<T> {
    const prior = this.commands.get(key);
    if (prior) {
      if (prior.signature !== signature) return Promise.reject(this.error("conflict"));
      return prior.result as Promise<T>;
    }
    if (this.commands.size >= this.limit) return Promise.reject(this.error("busy"));
    const result = Promise.resolve().then(work);
    this.commands.set(key, { signature, result });
    return result.finally(() => this.commands.delete(key));
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
