import { randomUUID } from "node:crypto";
import type { MySQLSession } from "../../database/mysql-session.js";
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
export class MySQLPublicationLeases {
  constructor(
    private db: MySQLSession,
    private now = Date.now,
    private kind = "site",
  ) {}
  async acquire(): Promise<PublicationLease | null> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.db.one<{
          id: string;
          phase: string;
          leaseFence: number;
          checkOnly: number;
        }>(
          "SELECT j.id,j.phase,j.leaseFence,j.checkOnly FROM panda_force_publication_jobs j JOIN panda_force_publication_plans p ON p.id=j.id WHERE p.kind=? AND (j.phase='queued' OR (j.phase='running' AND j.leaseUntil<=?) OR (j.phase='waiting' AND j.nextRunAt<=?)) ORDER BY j.rowSequence LIMIT 1",
          [this.kind, this.now(), this.now()],
        );
        if (!row) return null;
        const owner = randomUUID(),
          fence = row.leaseFence + 1;
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase='running',leaseOwner=?,leaseFence=?,leaseUntil=?,updatedAt=? WHERE id=?",
          [owner, fence, this.now() + 60000, this.now(), row.id],
        );
        return {
          id: row.id,
          owner,
          fence,
          checkOnly: Boolean(row.checkOnly),
          cleanup: row.checkOnly === 2,
          resumed: row.phase === "running",
        };
      });
    });
  }
  async guard<T>(lease: PublicationLease, operation: () => T | Promise<T>): Promise<T> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const owned = await this.db.one(
          "SELECT j.id FROM panda_force_publication_jobs j JOIN panda_force_publication_plans p ON p.id=j.id WHERE p.kind=? AND j.id=? AND j.phase='running' AND j.leaseOwner=? AND j.leaseFence=? AND j.leaseUntil>?",
          [this.kind, lease.id, lease.owner, lease.fence, this.now()],
        );
        if (!owned) throw new DeliveryError("leaseLost", 409);
        await this.db.execute("UPDATE panda_force_publication_jobs SET leaseUntil=? WHERE id=?", [
          this.now() + 60000,
          lease.id,
        ]);
        return await operation();
      });
    });
  }
  /** Preserve the running/resumed marker while making an unstarted claim immediately recoverable. */
  async release(lease: PublicationLease) {
    await this.db.execute(
      "UPDATE panda_force_publication_jobs SET leaseOwner=NULL,leaseUntil=0 WHERE id=? AND phase='running' AND leaseOwner=? AND leaseFence=?",
      [lease.id, lease.owner, lease.fence],
    );
  }
  async step(lease: PublicationLease, step: "staging" | "activating") {
    return await this.db.atomic(async () => {
      await this.guard(
        lease,
        async () =>
          await this.db.execute(
            "UPDATE panda_force_publication_jobs SET step=CASE WHEN step='activating' THEN step ELSE ? END,updatedAt=? WHERE id=?",
            [step, this.now(), lease.id],
          ),
      );
    });
  }
}
