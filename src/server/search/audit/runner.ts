import type { SearchAuditPersistence } from "../storage/ports.js";

import type { SearchScope, TextSearchProvider } from "../../../shared/search/contracts.js";

import { checkSearchGeneration, type SearchAuditPorts } from "./check.js";
/** Independent local/external slots coalesce requests; durable leases and backoff survive process restarts. */
export class SearchAuditRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = new Map<TextSearchProvider, Promise<void>>();
  private controllers = new Set<AbortController>();
  private unavailableUntil = new Map<string, number>();
  private closing = false;
  constructor(
    private ports: SearchAuditPorts,
    private audits: SearchAuditPersistence,
    private kickIndex: () => void,
    private report: (error: unknown) => void,
  ) {}
  start() {
    if (this.timer || this.closing) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
  }
  kick() {
    if (this.closing) return;
    for (const kind of ["local", "elasticsearch"] as const) {
      if (this.running.has(kind)) continue;
      this.running.set(
        kind,
        this.drain(kind)
          .catch(this.report)
          .finally(() => this.running.delete(kind)),
      );
    }
  }
  async request(scope: SearchScope) {
    const row = await this.ports.ledger.get(scope);
    if (!row || !(await this.audits.request(row, (await this.ports.runtime.source(row.source)).revision))) return false;
    this.kick();
    return true;
  }
  private async drain(kind: TextSearchProvider) {
    const rows = (await this.ports.ledger.all()).filter((row) => row.state === "ready" || row.state === "failed");
    const due = new Map<string, number>();
    for (const row of rows)
      due.set(row.key, (await this.audits.view(row, (await this.ports.runtime.source(row.source)).revision)).nextAt);
    rows.sort((a, b) => due.get(a.key)! - due.get(b.key)!);
    let performed = 0;
    for (const row of rows) {
      if (this.closing || performed >= 4) return;
      const source = await this.ports.runtime.source(row.source);
      if (source.kind !== kind || !source.enabled || !(await this.ports.ledger.settings(row)).enabled) continue;
      const fingerprint = (await this.ports.ledger.settings(row)).fulltext
        ? (await this.ports.runtime.text(source)).fingerprint()
        : "vector/" + ((await this.ports.runtime.vectors(source))?.fingerprint() ?? row.source);
      if ((this.unavailableUntil.get(fingerprint) ?? 0) > Date.now()) continue;
      const ticket = await this.audits.claim(row, source.revision);
      if (!ticket) continue;
      if (this.closing) return;
      performed++;
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 60000);
      this.controllers.add(controller);
      try {
        const outcome = await checkSearchGeneration(this.ports, ticket, controller.signal);
        if (outcome.status === "unavailable" || outcome.status === "forbidden")
          this.unavailableUntil.set(fingerprint, Date.now() + 60000);
        for (const [key, until] of this.unavailableUntil) if (until <= Date.now()) this.unavailableUntil.delete(key);
        while (this.unavailableUntil.size > 32)
          this.unavailableUntil.delete(this.unavailableUntil.keys().next().value!);
        const complete = await this.audits.finish(ticket, outcome, () => this.ports.ledger.invalidate(row.key, row));
        if (complete && outcome.action === "rebuild") this.kickIndex();
      } finally {
        clearTimeout(timeout);
        this.controllers.delete(controller);
      }
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.running.values());
  }
}
