import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { DeliveryError } from "../errors.js";

export interface PublicationLease {
  id: string;
  owner: string;
  fence: number;
  checkOnly: boolean;
  cleanup: boolean;
  resumed: boolean;
}
/** Lease acquisition and fencing contain no filesystem, network or content behavior. */
export class PublicationLeases {
  constructor(
    private db: Database,
    private now = Date.now,
    private kind = "site",
  ) {}
  acquire(): PublicationLease | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<{ id: string; phase: string; leaseFence: number; checkOnly: number }, [string, number, number]>(
            "SELECT j.id,j.phase,j.leaseFence,j.checkOnly FROM publication_jobs j JOIN publication_plans p ON p.id=j.id WHERE p.kind=? AND (j.phase='queued' OR (j.phase='running' AND j.leaseUntil<=?) OR (j.phase='waiting' AND j.nextRunAt<=?)) ORDER BY j.rowid LIMIT 1",
          )
          .get(this.kind, this.now(), this.now());
        if (!row) return null;
        const owner = randomUUID(),
          fence = row.leaseFence + 1;
        this.db
          .query(
            "UPDATE publication_jobs SET phase='running',leaseOwner=?,leaseFence=?,leaseUntil=?,updatedAt=? WHERE id=?",
          )
          .run(owner, fence, this.now() + 60000, this.now(), row.id);
        return {
          id: row.id,
          owner,
          fence,
          checkOnly: Boolean(row.checkOnly),
          cleanup: row.checkOnly === 2,
          resumed: row.phase === "running",
        };
      })
      .immediate();
  }
  guard<T>(lease: PublicationLease, operation: () => T): T {
    return this.db
      .transaction(() => {
        const owned = this.db
          .query(
            "SELECT j.id FROM publication_jobs j JOIN publication_plans p ON p.id=j.id WHERE p.kind=? AND j.id=? AND j.phase='running' AND j.leaseOwner=? AND j.leaseFence=? AND j.leaseUntil>?",
          )
          .get(this.kind, lease.id, lease.owner, lease.fence, this.now());
        if (!owned) throw new DeliveryError("leaseLost", 409);
        this.db.query("UPDATE publication_jobs SET leaseUntil=? WHERE id=?").run(this.now() + 60000, lease.id);
        return operation();
      })
      .immediate();
  }
  step(lease: PublicationLease, step: "staging" | "activating") {
    this.guard(lease, () =>
      this.db
        .query(
          "UPDATE publication_jobs SET step=CASE WHEN step='activating' THEN step ELSE ? END,updatedAt=? WHERE id=?",
        )
        .run(step, this.now(), lease.id),
    );
  }
}
