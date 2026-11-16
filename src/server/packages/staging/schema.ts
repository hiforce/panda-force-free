import type { Database } from "bun:sqlite";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";

function tables(db: Database, suffix: "" | "_next") {
  db.exec(`
    CREATE TABLE package_source_stages${suffix} (
      id TEXT PRIMARY KEY,actor TEXT NOT NULL,operationId TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('templates','skills')),
      request TEXT NOT NULL,limits TEXT NOT NULL,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN('reserved','uploading','uploaded','acquiring','writing','ready','failed','cancelled','removing','removed')),
      reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0),digest TEXT,origin TEXT,failure TEXT,
      token TEXT,expiresAt INTEGER,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
      UNIQUE(actor,operationId),CHECK((token IS NULL)=(expiresAt IS NULL)),
      CHECK((state IN('uploading','acquiring','writing'))=(token IS NOT NULL)),
      CHECK(state!='writing' OR digest IS NOT NULL),CHECK(state!='ready' OR (digest IS NOT NULL AND origin IS NOT NULL)),
      CHECK(state!='removed' OR reservedBytes=0)
    );
    CREATE TABLE package_source_stage_events${suffix} (
      id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL,digest TEXT,failure TEXT,
      PRIMARY KEY(id,revision),FOREIGN KEY(id) REFERENCES package_source_stages${suffix}(id)
    );
  `);
}

/** Legacy tasks retain their original entry policy, intent fingerprints and receipts after upgrades. */
export function migrateSourceStages(db: Database): void {
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 3) throw new SourceStageError("stageUnavailable");
    if (version === 0) tables(db, "");
    if (version === 1) {
      tables(db, "_next");
      db.exec(`
        INSERT INTO package_source_stages_next SELECT * FROM package_source_stages;
        INSERT INTO package_source_stage_events_next SELECT * FROM package_source_stage_events;
        DROP TABLE package_source_stage_events;
        DROP TABLE package_source_stages;
        ALTER TABLE package_source_stages_next RENAME TO package_source_stages;
        ALTER TABLE package_source_stage_events_next RENAME TO package_source_stage_events;
      `);
    }
    if (version < 3)
      db.exec(
        "ALTER TABLE package_source_stages ADD COLUMN entryPolicy TEXT NOT NULL DEFAULT 'regular-only/v1' CHECK(entryPolicy IN('regular-only/v1','logical-links/v2'))",
      );
    db.exec(
      "CREATE INDEX IF NOT EXISTS package_source_stages_actor ON package_source_stages(actor,state,updatedAt);PRAGMA user_version=3;",
    );
    if (db.query("PRAGMA foreign_key_check").all().length) throw new SourceStageError("stageUnavailable");
  }).immediate();
}
