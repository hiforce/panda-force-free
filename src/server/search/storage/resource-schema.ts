import type { Database } from "bun:sqlite";

/** Allocation and read leases share the activation ledger's transaction boundary; no original content is stored. */
export function migrateIndexResources(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_resources(
    storage TEXT NOT NULL,name TEXT NOT NULL,recipe TEXT NOT NULL,marker TEXT NOT NULL,
    identity TEXT,state TEXT NOT NULL,reference TEXT,token TEXT,leaseUntil INTEGER NOT NULL,
    orphanSince INTEGER,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
    PRIMARY KEY(storage,name));
    CREATE INDEX IF NOT EXISTS search_resources_scan ON search_resources(storage,name);
    CREATE INDEX IF NOT EXISTS search_resources_by_name ON search_resources(name);
    CREATE INDEX IF NOT EXISTS search_resources_live_scan ON search_resources(storage,name) WHERE state!='deleted';
    CREATE TABLE IF NOT EXISTS search_resource_reads(
      storage TEXT NOT NULL,name TEXT NOT NULL,token TEXT NOT NULL,leaseUntil INTEGER NOT NULL,
      PRIMARY KEY(storage,name,token),
      FOREIGN KEY(storage,name) REFERENCES search_resources(storage,name) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS search_resource_read_expiry ON search_resource_reads(leaseUntil);
    PRAGMA user_version=5;`);
}
