import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateDatabaseFile } from "../database/config.js";
import { isStoredAdministrator } from "./administrator-store.js";
import { isStoredPassword } from "./security.js";
import { migrateSQLiteModule, type MigrationTable } from "../database/data-migration.js";
import { identityMySQLModels } from "../database/modules/identity.js";
import { decodeMember } from "./users/records.js";
/** Final cutover captures application credentials and a fenced revocation snapshot, never the engine's auth.json or live SQLite WAL. */
export async function captureIdentitySnapshot(options: {
  directory: string;
  administratorPath?: string;
  passwordPath?: string;
  revocationsSnapshotPath?: string;
  usersSnapshotPath?: string;
}) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, "identity-" + randomUUID() + ".sqlite"),
    file = await open(path, "wx", 0o600);
  await file.close();
  const db = new Database(path, { create: false, strict: true });
  try {
    db.exec(
      "CREATE TABLE identity_credentials(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE revoked_sessions(digest TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);CREATE TABLE identity_users(id TEXT PRIMARY KEY,username TEXT NOT NULL,record TEXT NOT NULL,revision INTEGER NOT NULL);CREATE TABLE identity_settings(id INTEGER PRIMARY KEY,record TEXT NOT NULL,revision INTEGER NOT NULL)",
    );
    for (const [id, source, valid] of [
      ["administrator", options.administratorPath, isStoredAdministrator],
      ["managed-password", options.passwordPath, isStoredPassword],
    ] as const) {
      if (!source) continue;
      let value: unknown;
      try {
        value = JSON.parse((await readPrivateDatabaseFile(source)).toString("utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!valid(value)) throw Error("Invalid identity migration record");
      db.query("INSERT INTO identity_credentials VALUES(?,?)").run(id, JSON.stringify(value));
    }
    if (options.usersSnapshotPath) {
      const source = new Database(options.usersSnapshotPath, { readonly: true, strict: true });
      try {
        db.transaction(() => {
          for (const row of source.query<{ record: string }, []>("SELECT record FROM users").iterate()) {
            const user = decodeMember(row.record);
            db.query("INSERT INTO identity_users VALUES(?,?,?,?)").run(
              user.id,
              user.username,
              row.record,
              user.revision,
            );
          }
          for (const row of source
            .query<{ id: number; record: string; revision: number }, []>("SELECT id,record,revision FROM settings")
            .iterate()) {
            const value = JSON.parse(row.record);
            if (row.id !== 1 || value.revision !== row.revision)
              throw Error("Invalid local account settings migration record");
            db.query("INSERT INTO identity_settings VALUES(?,?,?)").run(row.id, row.record, row.revision);
          }
        }).immediate();
      } finally {
        source.close();
      }
    }
    if (options.revocationsSnapshotPath) {
      const source = new Database(options.revocationsSnapshotPath, { readonly: true, strict: true });
      try {
        const rows = source.query<{ digest: string; expires_at: number }, []>(
          "SELECT digest,expires_at FROM revoked_sessions",
        );
        db.transaction(() => {
          for (const row of rows.iterate()) {
            if (!/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.expires_at))
              throw Error("Invalid identity migration record");
            db.query("INSERT INTO revoked_sessions VALUES(?,?)").run(row.digest, row.expires_at);
          }
        }).immediate();
      } finally {
        source.close();
      }
    }
    db.close();
    return path;
  } catch (error) {
    db.close();
    await rm(path, { force: true });
    throw error;
  }
}
const tables: readonly MigrationTable[] = identityMySQLModels.map((m) => ({
  source: m.name.slice("panda_force_".length),
  target: m.name,
  columns: m.columns.map((c) => c.name),
  sourceKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  targetKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
  project: (r) => m.columns.map((c) => r[c.name] ?? null),
}));
export const migrateIdentitySnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, module: "identity", converterVersion: 1, tables });
