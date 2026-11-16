import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomUUID } from "node:crypto";
import type { SearchJobRow } from "../state.js";
import { auditGeneration, type AuditTicket, type AuditOutcome, type AuditReport } from "../audit/contracts.js";
interface QueueRow {
  generation: string;
  token: string | null;
  leaseUntil: number;
  nextAt: number;
  attempts: number;
}
export class MySQLSearchAudits {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  private async queue(key: string) {
    return await this.db.atomic(async () => {
      return await this.db.one<QueueRow>("SELECT * FROM panda_force_search_audit_queue WHERE `key`=?", [key]);
    });
  }
  private async current(row: SearchJobRow, sourceRevision: number) {
    return await this.db.atomic(async () => {
      return !!(await this.db.one(
        "SELECT 1 FROM panda_force_search_scopes s JOIN panda_force_search_sources p ON p.id=s.source WHERE s.`key`=? AND s.active <=> ? AND s.revision=? AND s.requested=? AND p.revision=? AND s.state IN ('ready','failed')",
        [row.key, row.active, row.revision, row.requested, sourceRevision],
      ));
    });
  }
  async claim(row: SearchJobRow, sourceRevision: number): Promise<AuditTicket | null> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        if (!(await this.current(row, sourceRevision))) return null;
        const generation = auditGeneration(row, sourceRevision),
          old = await this.queue(row.key),
          now = this.now();
        if (old?.token && old.leaseUntil > now) return null;
        if (old?.generation === generation && old.nextAt > now) return null;
        const token = randomUUID();
        await this.db.execute(
          "INSERT INTO panda_force_search_audit_queue(`key`,generation,token,leaseUntil,nextAt,attempts) VALUES(?,?,?,?,?,0) ON DUPLICATE KEY UPDATE attempts=CASE WHEN generation=VALUES(generation) THEN attempts ELSE 0 END,generation=VALUES(generation),token=VALUES(token),leaseUntil=VALUES(leaseUntil),nextAt=VALUES(nextAt)",
          [row.key, generation, token, now + 120000, now],
        );
        return { key: row.key, generation, token, row, sourceRevision };
      });
    });
  }
  /** The report and repair admission commit in one short transaction; network and file reads precede it. */
  async finish(ticket: AuditTicket, input: AuditOutcome, repair: () => boolean | Promise<boolean>) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const queue = await this.queue(ticket.key),
          now = this.now();
        if (!queue || queue.token !== ticket.token || queue.generation !== ticket.generation || queue.leaseUntil <= now)
          return false;
        let outcome = { ...input },
          repairQueued = false;
        if (!(await this.current(ticket.row, ticket.sourceRevision)))
          outcome = { status: "superseded", count: input.count, checks: input.checks, action: "none" };
        else if (input.action === "rebuild") {
          repairQueued = await repair();
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
        await this.db.execute(
          "INSERT INTO panda_force_search_audit_reports(`key`,generation,checkedAt,report) VALUES(?,?,?,?)",
          [ticket.key, ticket.generation, now, JSON.stringify(report)],
        );
        await this.db.execute(
          "UPDATE panda_force_search_audit_queue SET token=NULL,leaseUntil=0,nextAt=?,attempts=? WHERE `key`=? AND token=?",
          [now + delay, attempts, ticket.key, ticket.token],
        );
        await this.db.execute(
          "DELETE FROM panda_force_search_audit_reports WHERE `key`=? AND id NOT IN (SELECT id FROM (SELECT id FROM panda_force_search_audit_reports WHERE `key`=? ORDER BY id DESC LIMIT 8) retained_reports)",
          [ticket.key, ticket.key],
        );
        return true;
      });
    });
  }
  async request(row: SearchJobRow, sourceRevision: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        if (!(await this.current(row, sourceRevision))) return false;
        const old = await this.queue(row.key);
        if (old?.token && old.leaseUntil > this.now()) return true;
        await this.db.execute(
          "INSERT INTO panda_force_search_audit_queue(`key`,generation,token,leaseUntil,nextAt,attempts) VALUES(?,?,NULL,0,0,0) ON DUPLICATE KEY UPDATE attempts=CASE WHEN generation=VALUES(generation) THEN attempts ELSE 0 END,generation=VALUES(generation),token=NULL,leaseUntil=0,nextAt=0",
          [row.key, auditGeneration(row, sourceRevision)],
        );
        return true;
      });
    });
  }
  async view(row: SearchJobRow | null, sourceRevision: number) {
    return await this.db.atomic(async () => {
      const stored = row
          ? await this.db.one<{
              generation: string;
              report: string;
            }>(
              "SELECT generation,report FROM panda_force_search_audit_reports WHERE `key`=? ORDER BY id DESC LIMIT 1",
              [row.key],
            )
          : null,
        queue = row ? await this.queue(row.key) : null;
      return {
        current: !!row && stored?.generation === auditGeneration(row, sourceRevision),
        running: !!queue?.token && queue.leaseUntil > this.now(),
        queued: !!queue && !queue.token && queue.nextAt === 0,
        nextAt: row && queue?.generation === auditGeneration(row, sourceRevision) ? queue.nextAt : 0,
        latest: stored ? (JSON.parse(stored.report) as AuditReport) : null,
      };
    });
  }
}
