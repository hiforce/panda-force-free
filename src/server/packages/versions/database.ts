import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { VersionNamespace } from "./contracts.js";

import { versionNamespace } from "./namespace.js";
export { versionNamespace } from "./namespace.js";
/** Existing site-theme schema and row bytes remain unchanged; a different native format uses its own ledger. */
export function openVersionDatabase(path: string, namespace: VersionNamespace, unavailable: () => Error) {
  const prefix = versionNamespace(namespace);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw unavailable();
      if (!version)
        db.exec(`
        CREATE TABLE ${prefix}_owners(actor TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0));
        CREATE TABLE ${prefix}_versions(actor TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,descriptor TEXT NOT NULL,sourceId TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),installedAt INTEGER NOT NULL,PRIMARY KEY(actor,id,version));
        CREATE TABLE ${prefix}_heads(actor TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(actor,id),FOREIGN KEY(actor,id,version) REFERENCES ${prefix}_versions(actor,id,version));
        CREATE TABLE ${prefix}_operations(actor TEXT NOT NULL,operationId TEXT NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','committed','failed')),expectedRevision INTEGER NOT NULL,descriptor TEXT,digest TEXT NOT NULL,settingsDigest TEXT NOT NULL,receipt TEXT,cleaned INTEGER NOT NULL CHECK(cleaned IN(0,1)),createdAt INTEGER NOT NULL,PRIMARY KEY(actor,operationId),CHECK(state!='pending' OR descriptor IS NOT NULL),CHECK((state='committed')=(receipt IS NOT NULL)));
        CREATE TABLE ${prefix}_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,createdAt INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
      for (const suffix of ["owners", "versions", "heads", "operations", "audit"])
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(prefix + "_" + suffix))
          throw unavailable();
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
