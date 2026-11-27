import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { CliError } from "../../../shared/cli/contracts.js";
import type { CliCredentialStore, CliClientRecord, CliKeyRecord } from "./ports.js";
import { storedCliClient, storedCliKey, serializeCliProjects } from "./records.js";
import { mysqlInteger } from "../../database/mysql-model.js";

const nullableTime = (v: unknown) => (v === null ? null : mysqlInteger(v));
type Pair = { client: CliClientRecord; key: CliKeyRecord };
function pair(row: Record<string, unknown>): Pair {
  const client = storedCliClient({
    id: String(row.cId),
    owner: String(row.cOwner),
    name: String(row.cName),
    kind: row.cKind as CliClientRecord["kind"],
    createdAt: mysqlInteger(row.cCreatedAt),
    revokedAt: nullableTime(row.cRevokedAt),
  });
  return {
    client,
    key: storedCliKey({
      ...row,
      createdAt: mysqlInteger(row.createdAt),
      expiresAt: mysqlInteger(row.expiresAt),
      revokedAt: nullableTime(row.revokedAt),
      lastUsedAt: nullableTime(row.lastUsedAt),
    }),
  };
}
const projection =
  "SELECT c.id cId,c.owner cOwner,c.name cName,c.kind cKind,c.createdAt cCreatedAt,c.revokedAt cRevokedAt,k.* FROM panda_force_cli_keys k JOIN panda_force_cli_clients c ON c.id=k.clientId";
export function openMySQLCliCredentialStore(pool: SQL): { store: CliCredentialStore; close(): void } {
  const protect = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CliError) throw error;
      const failure = new CliError("unavailable", 503);
      failure.cause = error;
      throw failure;
    }
  };
  const store: CliCredentialStore = {
    issue: (client, key) =>
      protect(() =>
        pool.begin(async (sql) => {
          if (client.owner !== key.owner || client.id !== key.clientId) throw new CliError("invalidInput");
          const lock = createHash("sha256").update(client.owner).digest("hex");
          await sql`INSERT INTO panda_force_cli_control(id) VALUES(${lock}) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
          if (
            mysqlInteger(
              (
                await sql`SELECT COUNT(*) n FROM panda_force_cli_clients c JOIN panda_force_cli_keys k ON k.clientId=c.id WHERE c.owner=${client.owner} AND c.revokedAt IS NULL AND k.revokedAt IS NULL AND k.expiresAt>${key.createdAt}`
              )[0].n,
            ) >= 100
          )
            throw new CliError("limit", 429);
          await sql`INSERT INTO panda_force_cli_clients(id,owner,name,kind,createdAt,revokedAt) VALUES(${client.id},${client.owner},${client.name},${client.kind},${client.createdAt},${client.revokedAt})`;
          await sql`INSERT INTO panda_force_cli_keys(keyId,clientId,owner,digest,projects,capabilities,expiresAt,createdAt,revokedAt,lastUsedAt) VALUES(${key.keyId},${key.clientId},${key.owner},${key.digest},${serializeCliProjects(key)},${JSON.stringify(key.capabilities)},${key.expiresAt},${key.createdAt},${key.revokedAt},${key.lastUsedAt})`;
        }),
      ),
    find: (keyId) =>
      protect(async () => {
        const rows = await pool.unsafe(projection + " WHERE k.keyId=?", [keyId]);
        return rows[0] ? pair(rows[0]) : null;
      }),
    list: (owner) =>
      protect(async () =>
        (await pool.unsafe(projection + " WHERE k.owner=? ORDER BY k.createdAt DESC,k.keyId", [owner])).map(
          (r: Record<string, unknown>) => pair(r),
        ),
      ),
    touch: (keyId, now) =>
      protect(async () => {
        await pool`UPDATE panda_force_cli_keys SET lastUsedAt=${now} WHERE keyId=${keyId} AND (lastUsedAt IS NULL OR lastUsedAt<${now - 60000})`;
      }),
    revoke: (owner, clientId, now) =>
      protect(() =>
        pool.begin(async (sql) => {
          if (
            !(await sql`SELECT id FROM panda_force_cli_clients WHERE id=${clientId} AND owner=${owner} FOR UPDATE`)
              .length
          )
            throw new CliError("notFound", 404);
          await sql`UPDATE panda_force_cli_clients SET revokedAt=COALESCE(revokedAt,${now}) WHERE id=${clientId} AND owner=${owner}`;
          await sql`UPDATE panda_force_cli_keys SET revokedAt=COALESCE(revokedAt,${now}) WHERE clientId=${clientId} AND owner=${owner}`;
        }),
      ),
  };
  return { store, close() {} };
}
