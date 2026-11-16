import type { MySQLSession } from "../../database/mysql-session.js";
import { DeliveryError } from "../errors.js";
import type { MySQLPublicationLeases, PublicationLease } from "./mysql-leases.js";
/** Persist intent before dispatch and acknowledge only while the same lease is still held. */
export class MySQLPublicationEffects {
  constructor(
    private db: MySQLSession,
    private leases: Pick<MySQLPublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  async intent(lease: PublicationLease, operation: string) {
    return await this.db.atomic(async () => {
      return await this.leases.guard(lease, async () => {
        if (!/^[a-z][a-zA-Z.]{0,63}$/.test(operation)) throw new DeliveryError("invalidInput");
        const count = (await this.db.one<{
          count: number;
        }>("SELECT count(*) AS count FROM panda_force_publication_effects", []))!.count;
        if (count >= 100000) throw new DeliveryError("historyFull", 507);
        return Number(
          (
            await this.db.execute(
              "INSERT INTO panda_force_publication_effects(jobId,fence,operation,createdAt) VALUES(?,?,?,?)",
              [lease.id, lease.fence, operation, this.now()],
            )
          ).lastInsertRowid,
        );
      });
    });
  }
  async acknowledged(lease: PublicationLease, id: number) {
    return await this.db.atomic(async () => {
      await this.leases.guard(
        lease,
        async () =>
          await this.db.execute(
            "UPDATE panda_force_publication_effects SET acknowledgedAt=? WHERE id=? AND jobId=? AND fence=?",
            [this.now(), id, lease.id, lease.fence],
          ),
      );
    });
  }
}
