import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { SearchResourceInventoryView } from "../../../shared/search/resource-inventory.js";
import type { ResourceScanTicket } from "../resources/scan-contracts.js";
import type { IndexResourceCursor, IndexResourceObservation } from "../resources/inventory.js";
import {
  resourceScanCursor,
  mysqlResourceScanSummary,
  resourceScanPrevious,
  emptyResourceSummary,
  readResourceSummary,
  updateResourceSummary,
  type ResourceScanRow,
} from "./mysql-resource-scan-values.js";
import {
  initialResourceCursor,
  mysqlReadResourceScan,
  mysqlResetResourceScan,
} from "./mysql-resource-scan-recovery.js";
import { validStoredObservation } from "./mysql-resource-scan-validation.js";
import { mysqlResourceScanConnection, mysqlSelectResourceScanConnection } from "./mysql-resource-scan-selection.js";
/** One durable cycle owns each storage scan. Request receipts and transaction-bound batches survive uncertain replies. */
export class MySQLSearchResourceScans {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  private async get(storage: string) {
    return await this.db.atomic(async () => {
      return await mysqlReadResourceScan(this.db, storage, this.now);
    });
  }
  private async begin(storage: string, old: ResourceScanRow | null) {
    return await this.db.atomic(async () => {
      if (
        !/^[a-f0-9]{64}$/.test(storage) ||
        (old && (!Number.isSafeInteger(old.epoch) || old.epoch < 1 || old.epoch >= Number.MAX_SAFE_INTEGER))
      )
        throw new SearchError("configuration", 409);
      const previous =
        old?.completedAt !== null && old?.completedAt !== undefined
          ? JSON.stringify({ completedAt: old.completedAt, summary: await mysqlResourceScanSummary(this.db, old) })
          : (old?.previous ?? null);
      await this.db.execute(
        `INSERT INTO panda_force_search_resource_scans VALUES(?,?,'queued',NULL,0,?,?,0,NULL,NULL,NULL,0,NULL,?,?)
      ON DUPLICATE KEY UPDATE epoch=VALUES(epoch),state='queued',token=NULL,leaseUntil=0,nextAt=VALUES(nextAt),\`cursor\`=VALUES(\`cursor\`),batches=0,startedAt=NULL,checkedAt=NULL,completedAt=NULL,attempts=0,failure=NULL,previous=VALUES(previous),summary=VALUES(summary)`,
        [
          storage,
          (old?.epoch ?? 0) + 1,
          this.now(),
          initialResourceCursor,
          previous,
          JSON.stringify(emptyResourceSummary()),
        ],
      );
      return (await this.get(storage))!;
    });
  }
  async request(storage: string, operation: string, connection?: string) {
    return await this.db.atomic(async () => {
      if (
        !/^[a-f0-9]{64}$/.test(storage) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation)
      )
        throw new SearchError("invalidInput");
      await this.db.atomic(async () => {
        if (
          await this.db.one("SELECT 1 FROM panda_force_search_resource_requests WHERE storage=? AND operation=?", [
            storage,
            operation,
          ])
        )
          return;
        let row = await this.get(storage);
        if (!row || row.completedAt !== null) row = await this.begin(storage, row);
        else if (row.state === "failed")
          await this.db.execute(
            "UPDATE panda_force_search_resource_scans SET state='queued',token=NULL,leaseUntil=0,nextAt=?,attempts=0,failure=NULL WHERE storage=?",
            [this.now(), storage],
          );
        if (connection !== undefined) await mysqlSelectResourceScanConnection(this.db, storage, row.epoch, connection);
        await this.db.execute("INSERT INTO panda_force_search_resource_requests VALUES(?,?,?,?)", [
          storage,
          operation,
          row.epoch,
          this.now(),
        ]);
        await this.db.execute(
          "DELETE FROM panda_force_search_resource_requests WHERE storage=? AND operation NOT IN (SELECT operation FROM (SELECT operation FROM panda_force_search_resource_requests WHERE storage=? ORDER BY createdAt DESC,operation DESC LIMIT 128) retained_requests)",
          [storage, storage],
        );
      });
    });
  }
  async connection(storage: string) {
    return await this.db.atomic(async () => {
      const row = await this.get(storage);
      return row ? await mysqlResourceScanConnection(this.db, storage, row.epoch) : null;
    });
  }
  async claim(storage: string, automatic: boolean): Promise<ResourceScanTicket | null> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        let row = await this.get(storage);
        if (!row) {
          if (!automatic) return null;
          row = await this.begin(storage, null);
        }
        const now = this.now();
        if ((row.token && row.leaseUntil > now) || row.nextAt > now) return null;
        if (row.completedAt !== null) {
          if (!automatic) return null;
          row = await this.begin(storage, row);
        }
        if (row.state === "failed" && row.attempts >= 3) return null;
        const cursor = resourceScanCursor(row.cursor),
          token = randomUUID();
        await this.db.execute(
          "UPDATE panda_force_search_resource_scans SET state='running',token=?,leaseUntil=?,startedAt=COALESCE(startedAt,?),failure=NULL WHERE storage=?",
          [token, now + 120000, now, storage],
        );
        return { storage, epoch: row.epoch, token, cursor };
      });
    });
  }
  async heartbeat(ticket: ResourceScanTicket) {
    return this.db.atomic(async () => {
      const row = await this.db.one(
        "SELECT 1 FROM panda_force_search_resource_scans WHERE storage=? AND epoch=? AND token=? AND state='running' AND leaseUntil>?",
        [ticket.storage, ticket.epoch, ticket.token, this.now()],
      );
      if (!row) return false;
      await this.db.execute("UPDATE panda_force_search_resource_scans SET leaseUntil=? WHERE storage=?", [
        this.now() + 120000,
        ticket.storage,
      ]);
      return true;
    });
  }
  async finish(ticket: ResourceScanTicket, next: IndexResourceCursor, observations: IndexResourceObservation[]) {
    return await this.db.atomic(async () => {
      resourceScanCursor(JSON.stringify(next));
      if (
        observations.length > 16 ||
        new Set(observations.map((o) => o.name)).size !== observations.length ||
        observations.some(
          (o) =>
            !/^[a-f0-9]{64}$/.test(o.name) ||
            !["retained", "protected", "unowned", "unverified", "removed", "unavailable"].includes(o.status) ||
            typeof o.missing !== "boolean",
        )
      )
        throw new SearchError("configuration", 409);
      return await this.db.atomic(async () => {
        const row = await this.get(ticket.storage),
          now = this.now();
        if (
          !row ||
          row.epoch !== ticket.epoch ||
          row.token !== ticket.token ||
          row.leaseUntil <= now ||
          row.state !== "running"
        )
          return false;
        const summary = readResourceSummary(row.summary),
          updates: IndexResourceObservation[] = [];
        for (const incoming of observations) {
          const old = await this.db.one<
            Omit<IndexResourceObservation, "missing"> & {
              missing: number;
            }
          >(
            "SELECT name,status,missing FROM panda_force_search_resource_observations WHERE storage=? AND epoch=? AND name=?",
            [row.storage, row.epoch, incoming.name],
          );
          if (old && !validStoredObservation(old)) {
            await mysqlResetResourceScan(this.db, row, now);
            return false;
          }
          const o =
            old?.status === "removed" ? { name: old.name, status: "removed" as const, missing: false } : incoming;
          if (old) updateResourceSummary(summary, { ...old, missing: !!old.missing }, -1);
          updateResourceSummary(summary, o, 1);
          if (
            Object.values(summary).some((n) => n < 0) ||
            summary.protected + summary.retained + summary.removed > summary.checked ||
            summary.missing > summary.checked + summary.failed
          ) {
            await mysqlResetResourceScan(this.db, row, now);
            return false;
          }
          if (summary.checked + summary.failed > 100000) throw new SearchError("limit", 409);
          updates.push(o);
        }
        for (const o of updates) {
          await this.db.execute(
            `INSERT INTO panda_force_search_resource_observations VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE missing=CASE WHEN status='removed' THEN 0 ELSE VALUES(missing) END,status=CASE WHEN status='removed' THEN status ELSE VALUES(status) END,checkedAt=VALUES(checkedAt)`,
            [row.storage, row.epoch, o.name, o.status, o.missing ? 1 : 0, now],
          );
        }
        const complete = next.physical === null && next.allocations === null,
          failed = complete && summary.failed > 0;
        await this.db.execute(
          "UPDATE panda_force_search_resource_scans SET state=?,token=NULL,leaseUntil=0,nextAt=?,`cursor`=?,batches=batches+1,checkedAt=?,completedAt=?,attempts=?,failure=?,summary=? WHERE storage=?",
          [
            complete ? (failed ? "failed" : "ready") : "queued",
            now + (complete ? (failed ? 60000 : 300000) : 0),
            JSON.stringify(next),
            now,
            complete ? now : null,
            failed ? Math.min(row.attempts + 1, 16) : 0,
            failed ? "unavailable" : null,
            JSON.stringify(summary),
            row.storage,
          ],
        );
        await this.db.execute(
          "DELETE FROM panda_force_search_resource_observations WHERE storage=? AND epoch<? ORDER BY epoch,name LIMIT 256",
          [row.storage, row.epoch - 1],
        );
        return true;
      });
    });
  }
  async fail(ticket: ResourceScanTicket, code: NonNullable<SearchResourceInventoryView["failure"]>) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const row = await this.get(ticket.storage);
        if (!row || row.epoch !== ticket.epoch || row.token !== ticket.token || row.leaseUntil <= this.now()) return;
        const attempts = Math.min(16, row.attempts + 1),
          delay = code === "forbidden" ? 1800000 : Math.min(1800000, 30000 * 2 ** Math.min(attempts - 1, 6));
        await this.db.execute(
          "UPDATE panda_force_search_resource_scans SET state='failed',token=NULL,leaseUntil=0,nextAt=?,attempts=?,failure=? WHERE storage=?",
          [this.now() + delay, attempts, code, row.storage],
        );
      });
    });
  }
  async view(storage: string, automatic: boolean): Promise<SearchResourceInventoryView> {
    return await this.db.atomic(async () => {
      const row = await this.get(storage);
      if (!row)
        return {
          state: "idle",
          automatic,
          batches: 0,
          startedAt: null,
          checkedAt: null,
          completedAt: null,
          nextAt: null,
          failure: null,
          summary: emptyResourceSummary(),
          previous: null,
        };
      return {
        state: row.state === "running" && row.leaseUntil <= this.now() ? "queued" : row.state,
        automatic,
        batches: row.batches,
        startedAt: row.startedAt,
        checkedAt: row.checkedAt,
        completedAt: row.completedAt,
        nextAt:
          (row.completedAt === null && row.state === "failed" && row.attempts >= 3) ||
          (row.completedAt !== null && !automatic)
            ? null
            : row.nextAt,
        failure: row.failure,
        summary: await mysqlResourceScanSummary(this.db, row),
        previous: resourceScanPrevious(row.previous),
      };
    });
  }
}
