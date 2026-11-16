import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { migrateSkills } from "./schema.js";
export function openSkillDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=3000;PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;");
    migrateSkills(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
