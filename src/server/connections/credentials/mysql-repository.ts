import { randomUUID } from "node:crypto";
import type { MySQLSession } from "../../database/mysql-session.js";
import { CredentialError } from "./errors.js";
import type { CredentialBinding, CredentialLease, CredentialMetadata, SecretEnvelope } from "./ports.js";
interface Row extends CredentialBinding {
  revision: number;
  updatedAt: number;
  envelope: string;
  leaseOwner: string | null;
  leaseFence: number;
  leaseUntil: number;
  refreshDispatched: number;
}
/** Owns ciphertext persistence, compare-and-swap updates and refresh fencing; never decrypts values. */
export class MySQLCredentialRepository {
  constructor(
    private db: MySQLSession,
    private now = Date.now,
  ) {}
  async count() {
    return await this.db.atomic(async () => {
      return (await this.db.one<{
        total: number;
      }>("SELECT count(*) AS total FROM panda_force_publication_credentials", []))!.total;
    });
  }
  private async find(binding: CredentialBinding): Promise<Row | null> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<Row>("SELECT * FROM panda_force_publication_credentials WHERE connectionId=?", [
        binding.connectionId,
      ]);
      if (row && (row.connectorId !== binding.connectorId || row.ownerId !== binding.ownerId))
        throw new CredentialError("credentialMissing");
      return row;
    });
  }
  async get(binding: CredentialBinding): Promise<{
    metadata: CredentialMetadata;
    envelope: SecretEnvelope;
  }> {
    return await this.db.atomic(async () => {
      const row = await this.find(binding);
      if (!row) throw new CredentialError("credentialMissing");
      try {
        return {
          metadata: {
            revision: row.revision,
            updatedAt: row.updatedAt,
            refreshState: row.refreshDispatched ? (row.leaseUntil > this.now() ? "pending" : "uncertain") : "ready",
          },
          envelope: JSON.parse(row.envelope),
        };
      } catch {
        throw new CredentialError("unreadableCredential");
      }
    });
  }
  async put(
    binding: CredentialBinding,
    expected: number,
    envelope: SecretEnvelope,
    lease?: CredentialLease,
  ): Promise<CredentialMetadata> {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(expected) || expected < 0) throw new CredentialError("credentialConflict");
      return await this.db.atomic(async () => {
        const row = await this.find(binding),
          now = this.now();
        if ((row?.revision || 0) !== expected) throw new CredentialError("credentialConflict");
        if (
          lease &&
          (!row || row.leaseOwner !== lease.owner || row.leaseFence !== lease.fence || row.leaseUntil <= now)
        )
          throw new CredentialError("credentialConflict");
        const revision = expected + 1;
        if (row)
          await this.db.execute(
            `UPDATE panda_force_publication_credentials SET envelope=?,revision=?,updatedAt=?,leaseOwner=NULL,leaseUntil=0,leaseFence=leaseFence+1,refreshDispatched=0 WHERE connectionId=?`,
            [JSON.stringify(envelope), revision, now, binding.connectionId],
          );
        else
          await this.db.execute(
            `INSERT INTO panda_force_publication_credentials(connectionId,connectorId,ownerId,revision,envelope,updatedAt) VALUES(?,?,?,?,?,?)`,
            [binding.connectionId, binding.connectorId, binding.ownerId, revision, JSON.stringify(envelope), now],
          );
        return { revision, updatedAt: now, refreshState: "ready" as const };
      });
    });
  }
  async acquire(binding: CredentialBinding, revision: number, ttlMs = 30000): Promise<CredentialLease> {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120000)
        throw new CredentialError("invalidCredential");
      return await this.db.atomic(async () => {
        const row = await this.find(binding),
          now = this.now();
        if (!row) throw new CredentialError("credentialMissing");
        if (row.revision !== revision) throw new CredentialError("credentialConflict");
        if (row.leaseUntil > now) throw new CredentialError("refreshBusy");
        if (row.refreshDispatched) throw new CredentialError("refreshFailed");
        const lease = { owner: randomUUID(), fence: row.leaseFence + 1, expiresAt: now + ttlMs };
        await this.db.execute(
          "UPDATE panda_force_publication_credentials SET leaseOwner=?,leaseFence=?,leaseUntil=? WHERE connectionId=?",
          [lease.owner, lease.fence, lease.expiresAt, binding.connectionId],
        );
        return lease;
      });
    });
  }
  /** A dispatched refresh may rotate the remote token even if its response never reaches this process. */
  async dispatch(binding: CredentialBinding, lease: CredentialLease) {
    return await this.db.atomic(async () => {
      const result = await this.db.execute(
        "UPDATE panda_force_publication_credentials SET refreshDispatched=1 WHERE connectionId=? AND connectorId=? AND ownerId=? AND leaseOwner=? AND leaseFence=? AND leaseUntil>? AND refreshDispatched=0",
        [binding.connectionId, binding.connectorId, binding.ownerId, lease.owner, lease.fence, this.now()],
      );
      if (result.changes !== 1) throw new CredentialError("credentialConflict");
    });
  }
  async release(binding: CredentialBinding, lease: CredentialLease) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_publication_credentials SET leaseOwner=NULL,leaseUntil=0 WHERE connectionId=? AND connectorId=? AND ownerId=? AND leaseOwner=? AND leaseFence=?",
        [binding.connectionId, binding.connectorId, binding.ownerId, lease.owner, lease.fence],
      );
    });
  }
  async remove(binding: CredentialBinding, revision: number) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const row = await this.find(binding);
        if (!row) throw new CredentialError("credentialMissing");
        if (row.revision !== revision) throw new CredentialError("credentialConflict");
        await this.db.execute("DELETE FROM panda_force_publication_credentials WHERE connectionId=?", [
          binding.connectionId,
        ]);
      });
    });
  }
}
