import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { SearchResourceInventoryView } from "../../../shared/search/resource-inventory.js";
import type { ResourceScanStore, ResourceScanTicket } from "../resources/scan-contracts.js";
import type { IndexResourceCursor, IndexResourceObservation } from "../resources/inventory.js";
import {
  resourceScanCursor,
  resourceScanSummary,
  resourceScanPrevious,
  emptyResourceSummary,
  readResourceSummary,
  updateResourceSummary,
  type ResourceScanRow,
} from "./resource-scan-values.js";
import { initialResourceCursor, readResourceScan, resetResourceScan } from "./resource-scan-recovery.js";
import { validStoredObservation } from "./resource-scan-validation.js";
import { resourceScanConnection, selectResourceScanConnection } from "./resource-scan-selection.js";

/** One durable cycle owns each storage scan. Request receipts and transaction-bound batches survive uncertain replies. */
export class SearchResourceScans implements ResourceScanStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  private get(storage: string) {
    return readResourceScan(this.db, storage, this.now);
  }
  private begin(storage: string, old: ResourceScanRow | null) {
    if (
      !/^[a-f0-9]{64}$/.test(storage) ||
      (old && (!Number.isSafeInteger(old.epoch) || old.epoch < 1 || old.epoch >= Number.MAX_SAFE_INTEGER))
    )
      throw new SearchError("configuration", 409);
    const previous =
      old?.completedAt !== null && old?.completedAt !== undefined
        ? JSON.stringify({ completedAt: old.completedAt, summary: resourceScanSummary(this.db, old) })
        : (old?.previous ?? null);
    this.db
      .query(
        `INSERT INTO search_resource_scans VALUES(?,?,'queued',NULL,0,?,?,0,NULL,NULL,NULL,0,NULL,?,?)
      ON CONFLICT(storage) DO UPDATE SET epoch=excluded.epoch,state='queued',token=NULL,leaseUntil=0,nextAt=excluded.nextAt,cursor=excluded.cursor,batches=0,startedAt=NULL,checkedAt=NULL,completedAt=NULL,attempts=0,failure=NULL,previous=excluded.previous,summary=excluded.summary`,
      )
      .run(
        storage,
        (old?.epoch ?? 0) + 1,
        this.now(),
        initialResourceCursor,
        previous,
        JSON.stringify(emptyResourceSummary()),
      );
    return this.get(storage)!;
  }
  request(storage: string, operation: string, connection?: string) {
    if (
      !/^[a-f0-9]{64}$/.test(storage) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation)
    )
      throw new SearchError("invalidInput");
    this.db
      .transaction(() => {
        if (
          this.db
            .query("SELECT 1 FROM search_resource_requests WHERE storage=? AND operation=?")
            .get(storage, operation)
        )
          return;
        let row = this.get(storage);
        if (!row || row.completedAt !== null) row = this.begin(storage, row);
        else if (row.state === "failed")
          this.db
            .query(
              "UPDATE search_resource_scans SET state='queued',token=NULL,leaseUntil=0,nextAt=?,attempts=0,failure=NULL WHERE storage=?",
            )
            .run(this.now(), storage);
        if (connection !== undefined) selectResourceScanConnection(this.db, storage, row.epoch, connection);
        this.db
          .query("INSERT INTO search_resource_requests VALUES(?,?,?,?)")
          .run(storage, operation, row.epoch, this.now());
        this.db
          .query(
            "DELETE FROM search_resource_requests WHERE storage=? AND operation NOT IN (SELECT operation FROM search_resource_requests WHERE storage=? ORDER BY createdAt DESC,operation DESC LIMIT 128)",
          )
          .run(storage, storage);
      })
      .immediate();
  }
  connection(storage: string) {
    const row = this.get(storage);
    return row ? resourceScanConnection(this.db, storage, row.epoch) : null;
  }
  claim(storage: string, automatic: boolean): ResourceScanTicket | null {
    return this.db
      .transaction(() => {
        let row = this.get(storage);
        if (!row) {
          if (!automatic) return null;
          row = this.begin(storage, null);
        }
        const now = this.now();
        if ((row.token && row.leaseUntil > now) || row.nextAt > now) return null;
        if (row.completedAt !== null) {
          if (!automatic) return null;
          row = this.begin(storage, row);
        }
        if (row.state === "failed" && row.attempts >= 3) return null;
        const cursor = resourceScanCursor(row.cursor),
          token = randomUUID();
        this.db
          .query(
            "UPDATE search_resource_scans SET state='running',token=?,leaseUntil=?,startedAt=COALESCE(startedAt,?),failure=NULL WHERE storage=?",
          )
          .run(token, now + 120000, now, storage);
        return { storage, epoch: row.epoch, token, cursor };
      })
      .immediate();
  }
  heartbeat(ticket: ResourceScanTicket) {
    return (
      this.db
        .query(
          "UPDATE search_resource_scans SET leaseUntil=? WHERE storage=? AND epoch=? AND token=? AND state='running' AND leaseUntil>?",
        )
        .run(this.now() + 120000, ticket.storage, ticket.epoch, ticket.token, this.now()).changes === 1
    );
  }
  finish(ticket: ResourceScanTicket, next: IndexResourceCursor, observations: IndexResourceObservation[]) {
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
    return this.db
      .transaction(() => {
        const row = this.get(ticket.storage),
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
          const old = this.db
            .query<Omit<IndexResourceObservation, "missing"> & { missing: number }, [string, number, string]>(
              "SELECT name,status,missing FROM search_resource_observations WHERE storage=? AND epoch=? AND name=?",
            )
            .get(row.storage, row.epoch, incoming.name);
          if (old && !validStoredObservation(old)) {
            resetResourceScan(this.db, row, now);
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
            resetResourceScan(this.db, row, now);
            return false;
          }
          if (summary.checked + summary.failed > 100000) throw new SearchError("limit", 409);
          updates.push(o);
        }
        for (const o of updates) {
          this.db
            .query(
              `INSERT INTO search_resource_observations VALUES(?,?,?,?,?,?) ON CONFLICT(storage,epoch,name) DO UPDATE SET status=CASE WHEN status='removed' THEN status ELSE excluded.status END,missing=CASE WHEN status='removed' THEN 0 ELSE excluded.missing END,checkedAt=excluded.checkedAt`,
            )
            .run(row.storage, row.epoch, o.name, o.status, o.missing ? 1 : 0, now);
        }
        const complete = next.physical === null && next.allocations === null,
          failed = complete && summary.failed > 0;
        this.db
          .query(
            "UPDATE search_resource_scans SET state=?,token=NULL,leaseUntil=0,nextAt=?,cursor=?,batches=batches+1,checkedAt=?,completedAt=?,attempts=?,failure=?,summary=? WHERE storage=?",
          )
          .run(
            complete ? (failed ? "failed" : "ready") : "queued",
            now + (complete ? (failed ? 60000 : 300000) : 0),
            JSON.stringify(next),
            now,
            complete ? now : null,
            failed ? Math.min(row.attempts + 1, 16) : 0,
            failed ? "unavailable" : null,
            JSON.stringify(summary),
            row.storage,
          );
        this.db
          .query(
            "DELETE FROM search_resource_observations WHERE rowid IN (SELECT rowid FROM search_resource_observations WHERE storage=? AND epoch<? LIMIT 256)",
          )
          .run(row.storage, row.epoch - 1);
        return true;
      })
      .immediate();
  }
  fail(ticket: ResourceScanTicket, code: NonNullable<SearchResourceInventoryView["failure"]>) {
    this.db
      .transaction(() => {
        const row = this.get(ticket.storage);
        if (!row || row.epoch !== ticket.epoch || row.token !== ticket.token || row.leaseUntil <= this.now()) return;
        const attempts = Math.min(16, row.attempts + 1),
          delay = code === "forbidden" ? 1800000 : Math.min(1800000, 30000 * 2 ** Math.min(attempts - 1, 6));
        this.db
          .query(
            "UPDATE search_resource_scans SET state='failed',token=NULL,leaseUntil=0,nextAt=?,attempts=?,failure=? WHERE storage=?",
          )
          .run(this.now() + delay, attempts, code, row.storage);
      })
      .immediate();
  }
  view(storage: string, automatic: boolean): SearchResourceInventoryView {
    const row = this.get(storage);
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
      summary: resourceScanSummary(this.db, row),
      previous: resourceScanPrevious(row.previous),
    };
  }
}
