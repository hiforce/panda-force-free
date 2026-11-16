import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { SearchJobRow } from "../state.js";
import {
  auditGeneration,
  type AuditTicket,
  type AuditOutcome,
  type AuditReport,
  type SearchAuditStore,
} from "../audit/contracts.js";
interface QueueRow {
  generation: string;
  token: string | null;
  leaseUntil: number;
  nextAt: number;
  attempts: number;
}
export class SearchAudits implements SearchAuditStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  private queue(key: string) {
    return this.db.query<QueueRow, [string]>("SELECT * FROM search_audit_queue WHERE key=?").get(key);
  }
  private current(row: SearchJobRow, sourceRevision: number) {
    return !!this.db
      .query(
        "SELECT 1 FROM search_scopes s JOIN search_sources p ON p.id=s.source WHERE s.key=? AND s.active IS ? AND s.revision=? AND s.requested=? AND p.revision=? AND s.state IN ('ready','failed')",
      )
      .get(row.key, row.active, row.revision, row.requested, sourceRevision);
  }
  claim(row: SearchJobRow, sourceRevision: number): AuditTicket | null {
    return this.db
      .transaction(() => {
        if (!this.current(row, sourceRevision)) return null;
        const generation = auditGeneration(row, sourceRevision),
          old = this.queue(row.key),
          now = this.now();
        if (old?.token && old.leaseUntil > now) return null;
        if (old?.generation === generation && old.nextAt > now) return null;
        const token = randomUUID();
        this.db
          .query(
            "INSERT INTO search_audit_queue(key,generation,token,leaseUntil,nextAt,attempts) VALUES(?,?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,token=excluded.token,leaseUntil=excluded.leaseUntil,nextAt=excluded.nextAt,attempts=CASE WHEN generation=excluded.generation THEN attempts ELSE 0 END",
          )
          .run(row.key, generation, token, now + 120000, now);
        return { key: row.key, generation, token, row, sourceRevision };
      })
      .immediate();
  }
  /** The report and repair admission commit in one short transaction; network and file reads precede it. */
  finish(ticket: AuditTicket, input: AuditOutcome, repair: () => boolean) {
    return this.db
      .transaction(() => {
        const queue = this.queue(ticket.key),
          now = this.now();
        if (!queue || queue.token !== ticket.token || queue.generation !== ticket.generation || queue.leaseUntil <= now)
          return false;
        let outcome = { ...input },
          repairQueued = false;
        if (!this.current(ticket.row, ticket.sourceRevision))
          outcome = { status: "superseded", count: input.count, checks: input.checks, action: "none" };
        else if (input.action === "rebuild") {
          repairQueued = repair();
          if (!repairQueued) outcome = { ...input, status: "superseded", action: "none" };
        }
        const failed = outcome.status === "unavailable" || outcome.status === "forbidden" || repairQueued,
          attempts = failed ? Math.min(16, queue.attempts + 1) : outcome.status === "healthy" ? 0 : queue.attempts,
          delay =
            outcome.status === "superseded"
              ? 5000
              : outcome.status === "forbidden"
                ? 1800000
                : failed
                  ? Math.min(1800000, 30000 * 2 ** Math.min(attempts - 1, 6))
                  : outcome.status === "partial"
                    ? 900000
                    : 300000,
          report: AuditReport = { ...outcome, generation: ticket.generation, checkedAt: now, repairQueued };
        this.db
          .query("INSERT INTO search_audit_reports(key,generation,checkedAt,report) VALUES(?,?,?,?)")
          .run(ticket.key, ticket.generation, now, JSON.stringify(report));
        this.db
          .query("UPDATE search_audit_queue SET token=NULL,leaseUntil=0,nextAt=?,attempts=? WHERE key=? AND token=?")
          .run(now + delay, attempts, ticket.key, ticket.token);
        this.db
          .query(
            "DELETE FROM search_audit_reports WHERE key=? AND id NOT IN (SELECT id FROM search_audit_reports WHERE key=? ORDER BY id DESC LIMIT 8)",
          )
          .run(ticket.key, ticket.key);
        return true;
      })
      .immediate();
  }
  request(row: SearchJobRow, sourceRevision: number) {
    return this.db
      .transaction(() => {
        if (!this.current(row, sourceRevision)) return false;
        const old = this.queue(row.key);
        if (old?.token && old.leaseUntil > this.now()) return true;
        this.db
          .query(
            "INSERT INTO search_audit_queue(key,generation,token,leaseUntil,nextAt,attempts) VALUES(?,?,NULL,0,0,0) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,token=NULL,leaseUntil=0,nextAt=0,attempts=CASE WHEN generation=excluded.generation THEN attempts ELSE 0 END",
          )
          .run(row.key, auditGeneration(row, sourceRevision));
        return true;
      })
      .immediate();
  }
  view(row: SearchJobRow | null, sourceRevision: number) {
    const stored = row
        ? this.db
            .query<{ generation: string; report: string }, [string]>(
              "SELECT generation,report FROM search_audit_reports WHERE key=? ORDER BY id DESC LIMIT 1",
            )
            .get(row.key)
        : null,
      queue = row ? this.queue(row.key) : null;
    return {
      current: !!row && stored?.generation === auditGeneration(row, sourceRevision),
      running: !!queue?.token && queue.leaseUntil > this.now(),
      queued: !!queue && !queue.token && queue.nextAt === 0,
      nextAt: row && queue?.generation === auditGeneration(row, sourceRevision) ? queue.nextAt : 0,
      latest: stored ? (JSON.parse(stored.report) as AuditReport) : null,
    };
  }
}
