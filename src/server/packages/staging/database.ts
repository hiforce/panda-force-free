import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateSourceStages } from "./schema.js";

/** Staging metadata, audit receipts and reservations are separate from source body files. */
export function openSourceStageDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;");
    migrateSourceStages(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
