import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { SiteBuildError } from "../errors.js";

/** Resource payloads live in immutable files; this database owns admissions, capacity and execution receipts only. */
export function openNativeSampleDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw new SiteBuildError("unavailable", 503);
      if (!version)
        db.exec(
          `CREATE TABLE native_sample_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,signature TEXT NOT NULL,sampleKey TEXT NOT NULL,record TEXT NOT NULL,inputReady INTEGER NOT NULL DEFAULT 0 CHECK(inputReady IN(0,1)),terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN(0,1)),reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0),removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN(0,1)),logs TEXT NOT NULL DEFAULT ''); CREATE INDEX native_sample_key ON native_sample_runs(owner,sampleKey,removed); PRAGMA user_version=1;`,
        );
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
