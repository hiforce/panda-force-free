import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  CredentialBinding,
  CredentialLease,
  CredentialMetadata,
  SecretEnvelope,
  CredentialStore,
} from "./ports.js";
import { CredentialError } from "./errors.js";

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
export class CredentialRepository implements CredentialStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_credential_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    db.transaction(() => {
      const version =
        db.query<{ version: number }, []>("SELECT version FROM publication_credential_schema WHERE id=1").get()
          ?.version || 0;
      if (version > 2) throw new CredentialError("credentialStoreUnavailable");
      if (!version)
        db.exec(`CREATE TABLE publication_credentials (
        connectionId TEXT PRIMARY KEY, connectorId TEXT NOT NULL, ownerId TEXT NOT NULL,
        revision INTEGER NOT NULL, envelope TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        leaseOwner TEXT, leaseFence INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0
      ); INSERT INTO publication_credential_schema VALUES(1,1);`);
      if (version < 2)
        db.exec(`ALTER TABLE publication_credentials ADD COLUMN refreshDispatched INTEGER NOT NULL DEFAULT 0;
        UPDATE publication_credentials SET refreshDispatched=1 WHERE leaseOwner IS NOT NULL;
        UPDATE publication_credential_schema SET version=2 WHERE id=1;`);
    }).immediate();
  }
  count() {
    return this.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_credentials").get()!.total;
  }
  private find(binding: CredentialBinding): Row | null {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM publication_credentials WHERE connectionId=?")
      .get(binding.connectionId);
    if (row && (row.connectorId !== binding.connectorId || row.ownerId !== binding.ownerId))
      throw new CredentialError("credentialMissing");
    return row;
  }
  get(binding: CredentialBinding): { metadata: CredentialMetadata; envelope: SecretEnvelope } {
    const row = this.find(binding);
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
  }
  put(
    binding: CredentialBinding,
    expected: number,
    envelope: SecretEnvelope,
    lease?: CredentialLease,
  ): CredentialMetadata {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new CredentialError("credentialConflict");
    return this.db
      .transaction(() => {
        const row = this.find(binding),
          now = this.now();
        if ((row?.revision || 0) !== expected) throw new CredentialError("credentialConflict");
        if (
          lease &&
          (!row || row.leaseOwner !== lease.owner || row.leaseFence !== lease.fence || row.leaseUntil <= now)
        )
          throw new CredentialError("credentialConflict");
        const revision = expected + 1;
        if (row)
          this.db
            .query(
              `UPDATE publication_credentials SET envelope=?,revision=?,updatedAt=?,leaseOwner=NULL,leaseUntil=0,leaseFence=leaseFence+1,refreshDispatched=0 WHERE connectionId=?`,
            )
            .run(JSON.stringify(envelope), revision, now, binding.connectionId);
        else
          this.db
            .query(
              `INSERT INTO publication_credentials(connectionId,connectorId,ownerId,revision,envelope,updatedAt) VALUES(?,?,?,?,?,?)`,
            )
            .run(binding.connectionId, binding.connectorId, binding.ownerId, revision, JSON.stringify(envelope), now);
        return { revision, updatedAt: now, refreshState: "ready" as const };
      })
      .immediate();
  }
  acquire(binding: CredentialBinding, revision: number, ttlMs = 30000): CredentialLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120000) throw new CredentialError("invalidCredential");
    return this.db
      .transaction(() => {
        const row = this.find(binding),
          now = this.now();
        if (!row) throw new CredentialError("credentialMissing");
        if (row.revision !== revision) throw new CredentialError("credentialConflict");
        if (row.leaseUntil > now) throw new CredentialError("refreshBusy");
        if (row.refreshDispatched) throw new CredentialError("refreshFailed");
        const lease = { owner: randomUUID(), fence: row.leaseFence + 1, expiresAt: now + ttlMs };
        this.db
          .query("UPDATE publication_credentials SET leaseOwner=?,leaseFence=?,leaseUntil=? WHERE connectionId=?")
          .run(lease.owner, lease.fence, lease.expiresAt, binding.connectionId);
        return lease;
      })
      .immediate();
  }
  /** A dispatched refresh may rotate the remote token even if its response never reaches this process. */
  dispatch(binding: CredentialBinding, lease: CredentialLease) {
    const result = this.db
      .query(
        "UPDATE publication_credentials SET refreshDispatched=1 WHERE connectionId=? AND connectorId=? AND ownerId=? AND leaseOwner=? AND leaseFence=? AND leaseUntil>? AND refreshDispatched=0",
      )
      .run(binding.connectionId, binding.connectorId, binding.ownerId, lease.owner, lease.fence, this.now());
    if (result.changes !== 1) throw new CredentialError("credentialConflict");
  }
  release(binding: CredentialBinding, lease: CredentialLease) {
    this.db
      .query(
        "UPDATE publication_credentials SET leaseOwner=NULL,leaseUntil=0 WHERE connectionId=? AND connectorId=? AND ownerId=? AND leaseOwner=? AND leaseFence=?",
      )
      .run(binding.connectionId, binding.connectorId, binding.ownerId, lease.owner, lease.fence);
  }
  remove(binding: CredentialBinding, revision: number) {
    this.db
      .transaction(() => {
        const row = this.find(binding);
        if (!row) throw new CredentialError("credentialMissing");
        if (row.revision !== revision) throw new CredentialError("credentialConflict");
        this.db.query("DELETE FROM publication_credentials WHERE connectionId=?").run(binding.connectionId);
      })
      .immediate();
  }
}
