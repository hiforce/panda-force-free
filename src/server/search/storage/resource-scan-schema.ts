import type { Database } from "bun:sqlite";

/** Checkpointed metadata observations are scoped to an installation-owned storage identity, never document bodies. */
export function migrateResourceScans(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_resource_scans(
    storage TEXT PRIMARY KEY,epoch INTEGER NOT NULL,state TEXT NOT NULL,token TEXT,leaseUntil INTEGER NOT NULL,
    nextAt INTEGER NOT NULL,cursor TEXT NOT NULL,batches INTEGER NOT NULL,startedAt INTEGER,checkedAt INTEGER,
    completedAt INTEGER,attempts INTEGER NOT NULL,failure TEXT,previous TEXT,summary TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS search_resource_observations(
      storage TEXT NOT NULL REFERENCES search_resource_scans(storage) ON DELETE CASCADE,
      epoch INTEGER NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,missing INTEGER NOT NULL,checkedAt INTEGER NOT NULL,
      PRIMARY KEY(storage,epoch,name));
    CREATE TABLE IF NOT EXISTS search_resource_requests(
      storage TEXT NOT NULL REFERENCES search_resource_scans(storage) ON DELETE CASCADE,
      operation TEXT NOT NULL,epoch INTEGER NOT NULL,createdAt INTEGER NOT NULL,
      PRIMARY KEY(storage,operation));
    CREATE INDEX IF NOT EXISTS search_resources_cleanup_times ON search_resources(storage,state,updatedAt);
    PRAGMA user_version=6;`);
}
