import type { Database } from "bun:sqlite";

/** Additive metadata migration retains all historical identities, operation receipts, policies and quota rows. */
export function migrateGenerationSources(db: Database) {
  for (const table of ["knowledge_generation_jobs", "knowledge_generation_origins"])
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN sourceKind TEXT NOT NULL DEFAULT 'document' CHECK(sourceKind IN ('document','web','slides'));`,
    );
  db.exec("PRAGMA user_version=8;");
}
