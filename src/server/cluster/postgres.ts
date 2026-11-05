import { SQL, type TransactionSQL } from "bun";
import type { CoordinationStore, JournalEvent, OwnerLease, OperationClaim } from "./contracts.js";
import { ClusterError } from "./contracts.js";
import { CLUSTER_SCHEMA } from "./schema.js";

type LeaseRow = {
  workspace: string;
  node_id: string;
  boot_id: string;
  address: string;
  fence: string;
  expires: number;
  now: number;
  released: boolean;
};
const leaseColumns =
  "workspace, node_id, boot_id, address, fence::text, extract(epoch from expires_at)*1000 AS expires, extract(epoch from clock_timestamp())*1000 AS now, released";
const decodeLease = (row: LeaseRow): OwnerLease => ({
  workspace: row.workspace,
  nodeId: row.node_id,
  bootId: row.boot_id,
  address: row.address,
  fence: Number(row.fence),
  expiresAt: Number(row.expires),
  databaseNow: Number(row.now),
  released: row.released,
});
const lost = () => new ClusterError("Workspace ownership is unavailable", "cluster_owner_unavailable");

/** Shared coordination is separate from the single owner's local workspace data. */
export function createPostgresCoordination(databaseUrl: string): CoordinationStore {
  const sql = new SQL(databaseUrl, { max: 8, connectionTimeout: 5, idleTimeout: 15 });
  let maintenance: Promise<void> | null = null,
    nextMaintenance = 0;
  function scheduleMaintenance(workspace: string) {
    if (maintenance || Date.now() < nextMaintenance) return;
    nextMaintenance = Date.now() + 60_000;
    maintenance = sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL statement_timeout = '5s'");
        await tx.unsafe("DELETE FROM panda_cluster_nonces WHERE workspace=$1 AND expires_at<clock_timestamp()", [
          workspace,
        ]);
        await tx.unsafe(
          "DELETE FROM panda_cluster_events WHERE workspace=$1 AND created_at<clock_timestamp()-interval '1 day'",
          [workspace],
        );
        // Keep command tombstones so retention can never make an uncertain write executable.
        await tx.unsafe(
          "UPDATE panda_cluster_operations SET state='uncertain',result=NULL WHERE workspace=$1 AND state='completed' AND created_at<clock_timestamp()-interval '7 days'",
          [workspace],
        );
      })
      .then(() => {})
      .catch(() => {
        console.warn("[PandaForce] cluster/retention-retry");
      })
      .finally(() => {
        maintenance = null;
      });
  }
  async function authorized(tx: TransactionSQL, lease: OwnerLease) {
    const rows = await tx.unsafe<{ workspace: string }[]>(
      "SELECT workspace FROM panda_workspace_owners WHERE workspace=$1 AND boot_id=$2 AND fence=$3 AND NOT released AND expires_at>clock_timestamp() FOR SHARE",
      [lease.workspace, lease.bootId, lease.fence],
    );
    if (!rows.length) throw lost();
  }
  return {
    async initialize() {
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(74631209)");
        for (const statement of CLUSTER_SCHEMA.split(";").filter((value) => value.trim())) await tx.unsafe(statement);
      });
    },
    async claimOwner({ workspace, nodeId, bootId, address, leaseMs, recoverFence = null }) {
      return sql.begin(async (tx) => {
        // The insert and row lock serialize independent processes claiming a new workspace.
        await tx.unsafe(
          "INSERT INTO panda_workspace_owners(workspace,node_id,boot_id,address,fence,expires_at,released) VALUES($1,$2,$3,$4,0,clock_timestamp(),TRUE) ON CONFLICT DO NOTHING",
          [workspace, nodeId, bootId, address],
        );
        const rows = await tx.unsafe<LeaseRow[]>(
          `SELECT ${leaseColumns} FROM panda_workspace_owners WHERE workspace=$1 FOR UPDATE`,
          [workspace],
        );
        const current = decodeLease(rows[0]);
        const recoverable = recoverFence === current.fence && current.expiresAt <= current.databaseNow;
        if (!current.released && !recoverable)
          throw new ClusterError(
            "The previous workspace owner must stop before ownership can transfer",
            "cluster_owner_busy",
            409,
          );
        const result = await tx.unsafe<LeaseRow[]>(
          `UPDATE panda_workspace_owners SET node_id=$2,boot_id=$3,address=$4,fence=fence+1,expires_at=clock_timestamp()+($5::double precision * interval '1 millisecond'),released=FALSE WHERE workspace=$1 RETURNING ${leaseColumns}`,
          [workspace, nodeId, bootId, address, leaseMs],
        );
        await tx.unsafe(
          "UPDATE panda_cluster_operations SET state='uncertain' WHERE workspace=$1 AND state='running'",
          [workspace],
        );
        return decodeLease(result[0]);
      });
    },
    async currentOwner(workspace) {
      const rows = await sql.unsafe<LeaseRow[]>(
        `SELECT ${leaseColumns} FROM panda_workspace_owners WHERE workspace=$1 AND NOT released AND expires_at>clock_timestamp()`,
        [workspace],
      );
      return rows.length ? decodeLease(rows[0]) : null;
    },
    async renew(lease, leaseMs) {
      const rows = await sql.unsafe<LeaseRow[]>(
        `UPDATE panda_workspace_owners SET expires_at=clock_timestamp()+($4::double precision * interval '1 millisecond') WHERE workspace=$1 AND boot_id=$2 AND fence=$3 AND NOT released AND expires_at>clock_timestamp() RETURNING ${leaseColumns}`,
        [lease.workspace, lease.bootId, lease.fence, leaseMs],
      );
      if (!rows.length) throw lost();
      scheduleMaintenance(lease.workspace);
      return decodeLease(rows[0]);
    },
    async release(lease) {
      await sql.unsafe(
        "UPDATE panda_workspace_owners SET released=TRUE,expires_at=clock_timestamp() WHERE workspace=$1 AND boot_id=$2 AND fence=$3",
        [lease.workspace, lease.bootId, lease.fence],
      );
    },
    async acceptNonce(lease, nonce) {
      return sql.begin(async (tx) => {
        await authorized(tx, lease);
        const result = await tx.unsafe<{ nonce: string }[]>(
          "INSERT INTO panda_cluster_nonces(workspace,nonce,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 minute') ON CONFLICT DO NOTHING RETURNING nonce",
          [lease.workspace, nonce],
        );
        return result.length === 1;
      });
    },
    async appendEvent(lease, data) {
      return sql.begin(async (tx) => {
        await authorized(tx, lease);
        const rows = await tx.unsafe<{ sequence: string }[]>(
          "INSERT INTO panda_cluster_events(workspace,fence,data) VALUES($1,$2,$3::jsonb) RETURNING sequence::text",
          [lease.workspace, lease.fence, data],
        );
        return { sequence: Number(rows[0].sequence), fence: lease.fence, data };
      });
    },
    async readEvents(workspace, fence, after, limit = 500) {
      const rows = await sql.unsafe<{ sequence: string; fence: string; data: unknown }[]>(
        "SELECT sequence::text, fence::text, data FROM panda_cluster_events WHERE workspace=$1 AND fence=$2 AND sequence>$3 ORDER BY sequence LIMIT $4",
        [workspace, fence, after, Math.min(1000, Math.max(1, limit))],
      );
      return rows.map((row): JournalEvent => ({
        sequence: Number(row.sequence),
        fence: Number(row.fence),
        data: row.data,
      }));
    },
    async beginOperation(lease, id, digest): Promise<OperationClaim> {
      return sql.begin(async (tx) => {
        await authorized(tx, lease);
        const inserted = await tx.unsafe<{ operation_id: string }[]>(
          "INSERT INTO panda_cluster_operations(workspace,operation_id,digest,fence,state) VALUES($1,$2,$3,$4,'running') ON CONFLICT DO NOTHING RETURNING operation_id",
          [lease.workspace, id, digest, lease.fence],
        );
        if (inserted.length) return { kind: "acquired" };
        const rows = await tx.unsafe<{ digest: string; state: string; result: unknown }[]>(
          "SELECT digest,state,result FROM panda_cluster_operations WHERE workspace=$1 AND operation_id=$2",
          [lease.workspace, id],
        );
        const current = rows[0];
        if (current.digest !== digest) return { kind: "conflict" };
        if (current.state === "completed") return { kind: "completed", result: current.result };
        return { kind: "uncertain" };
      });
    },
    async completeOperation(lease, id, digest, result) {
      await sql.begin(async (tx) => {
        await authorized(tx, lease);
        const json = JSON.stringify(result ?? null);
        const completed = Buffer.byteLength(json) <= 2 * 1024 * 1024;
        const updated = await tx.unsafe<{ operation_id: string }[]>(
          "UPDATE panda_cluster_operations SET state=$5,result=$6::jsonb WHERE workspace=$1 AND operation_id=$2 AND digest=$3 AND fence=$4 AND state='running' RETURNING operation_id",
          [
            lease.workspace,
            id,
            digest,
            lease.fence,
            completed ? "completed" : "uncertain",
            completed ? (result ?? null) : null,
          ],
        );
        if (updated.length !== 1)
          throw new ClusterError("The operation result could not be confirmed", "cluster_delivery_uncertain");
      });
    },
    async close() {
      await maintenance;
      await sql.close();
    },
  };
}
