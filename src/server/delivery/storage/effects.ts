import type { Database } from "bun:sqlite";
import type { PublicationLease, PublicationLeases } from "./leases.js";
import { DeliveryError } from "../errors.js";

/** Persist intent before dispatch and acknowledge only while the same lease is still held. */
export class PublicationEffects {
  constructor(
    private db: Database,
    private leases: Pick<PublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  intent(lease: PublicationLease, operation: string) {
    return this.leases.guard(lease, () => {
      if (!/^[a-z][a-zA-Z.]{0,63}$/.test(operation)) throw new DeliveryError("invalidInput");
      const count = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM publication_effects").get()!
        .count;
      if (count >= 100000) throw new DeliveryError("historyFull", 507);
      return Number(
        this.db
          .query("INSERT INTO publication_effects(jobId,fence,operation,createdAt) VALUES(?,?,?,?)")
          .run(lease.id, lease.fence, operation, this.now()).lastInsertRowid,
      );
    });
  }
  acknowledged(lease: PublicationLease, id: number) {
    this.leases.guard(lease, () =>
      this.db
        .query("UPDATE publication_effects SET acknowledgedAt=? WHERE id=? AND jobId=? AND fence=?")
        .run(this.now(), id, lease.id, lease.fence),
    );
  }
}
