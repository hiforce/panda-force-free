import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "../../../shared/cli/contracts.js";
import type { CliClientRecord, CliCredentialStore } from "./ports.js";
import { storedCliClient, storedCliKey } from "./records.js";
export function openCliCredentialStore(path: string): { store: CliCredentialStore; close(): void } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!lstatSync(dirname(path)).isDirectory() || lstatSync(dirname(path)).isSymbolicLink())
      throw new CliError("unavailable", 503);
    for (const file of [path, path + "-wal", path + "-shm"]) {
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new CliError("unavailable", 503);
    }
  }
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw new CliError("unavailable", 503);
      if (!version)
        db.exec(`
        CREATE TABLE cli_clients(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('codex','claude','cli')), createdAt INTEGER NOT NULL, revokedAt INTEGER);
        CREATE TABLE cli_keys(keyId TEXT PRIMARY KEY, clientId TEXT NOT NULL UNIQUE REFERENCES cli_clients(id), owner TEXT NOT NULL, digest TEXT NOT NULL, projects TEXT NOT NULL, capabilities TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, revokedAt INTEGER, lastUsedAt INTEGER);
        CREATE INDEX cli_clients_owner ON cli_clients(owner,createdAt);
        PRAGMA user_version=1;
      `);
    }).immediate();
    const find = (id: string) => {
      const stored = db.query<Record<string, unknown>, [string]>("SELECT * FROM cli_keys WHERE keyId=?").get(id);
      if (!stored) return null;
      const client = db
        .query<CliClientRecord, [string]>("SELECT * FROM cli_clients WHERE id=?")
        .get(String(stored.clientId));
      return client ? { client: storedCliClient(client), key: storedCliKey(stored) } : null;
    };
    const store: CliCredentialStore = {
      issue: (client, credential) =>
        db
          .transaction(() => {
            if (
              db
                .query<{ n: number }, [string, number]>(
                  "SELECT count(*) AS n FROM cli_clients c JOIN cli_keys k ON k.clientId=c.id WHERE c.owner=? AND c.revokedAt IS NULL AND k.revokedAt IS NULL AND k.expiresAt>?",
                )
                .get(client.owner, credential.createdAt)!.n >= 100
            )
              throw new CliError("limit", 429);
            db.query("INSERT INTO cli_clients VALUES(?,?,?,?,?,?)").run(
              client.id,
              client.owner,
              client.name,
              client.kind,
              client.createdAt,
              client.revokedAt,
            );
            db.query("INSERT INTO cli_keys VALUES(?,?,?,?,?,?,?,?,?,?)").run(
              credential.keyId,
              credential.clientId,
              credential.owner,
              credential.digest,
              JSON.stringify(credential.projects),
              JSON.stringify(credential.capabilities),
              credential.expiresAt,
              credential.createdAt,
              credential.revokedAt,
              credential.lastUsedAt,
            );
          })
          .immediate(),
      find,
      list: (owner) =>
        db
          .query<{ keyId: string }, [string]>("SELECT keyId FROM cli_keys WHERE owner=? ORDER BY createdAt DESC,keyId")
          .all(owner)
          .map((row) => find(row.keyId)!),
      touch: (id, now) => {
        db.query("UPDATE cli_keys SET lastUsedAt=? WHERE keyId=? AND (lastUsedAt IS NULL OR lastUsedAt<?)").run(
          now,
          id,
          now - 60000,
        );
      },
      revoke: (owner, clientId, now) =>
        db
          .transaction(() => {
            if (
              !db
                .query("UPDATE cli_clients SET revokedAt=coalesce(revokedAt,?) WHERE id=? AND owner=?")
                .run(now, clientId, owner).changes
            )
              throw new CliError("notFound", 404);
            db.query("UPDATE cli_keys SET revokedAt=coalesce(revokedAt,?) WHERE clientId=? AND owner=?").run(
              now,
              clientId,
              owner,
            );
          })
          .immediate(),
    };
    return { store, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
