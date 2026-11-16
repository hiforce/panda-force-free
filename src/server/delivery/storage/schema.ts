import type { Database } from "bun:sqlite";
import { DeliveryError } from "../errors.js";

/** Upgrade storage without rewriting immutable plans or their fingerprints. */
export function initializePublicationSchema(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS publication_delivery_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
  );
  db.transaction(() => {
    const version =
      db.query<{ version: number }, []>("SELECT version FROM publication_delivery_schema WHERE id=1").get()?.version ||
      0;
    if (version > 9) throw new DeliveryError("unavailable", 503);
    if (!version)
      db.exec(`CREATE TABLE publication_snapshots(hash TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE publication_plans(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,spaceId TEXT NOT NULL,connectionId TEXT NOT NULL,record TEXT NOT NULL,request TEXT NOT NULL,artifactHash TEXT REFERENCES publication_snapshots(hash));
        CREATE TABLE publication_jobs(id TEXT PRIMARY KEY REFERENCES publication_plans(id),phase TEXT NOT NULL,step TEXT,updatedAt INTEGER NOT NULL,error TEXT,receipt TEXT,leaseOwner TEXT,leaseFence INTEGER NOT NULL DEFAULT 0,leaseUntil INTEGER NOT NULL DEFAULT 0,checkOnly INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX publications_by_owner ON publication_plans(ownerId,spaceId);
        CREATE INDEX publication_active_jobs ON publication_jobs(phase,leaseUntil);
        INSERT INTO publication_delivery_schema VALUES(1,1);`);
    if (version < 2)
      db.exec(`CREATE TABLE publication_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL REFERENCES publication_jobs(id),
        fence INTEGER NOT NULL, operation TEXT NOT NULL, createdAt INTEGER NOT NULL, acknowledgedAt INTEGER
      ); CREATE INDEX effects_by_job ON publication_effects(jobId,id);
      UPDATE publication_delivery_schema SET version=2 WHERE id=1;`);
    if (version < 3)
      db.exec(`ALTER TABLE publication_plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';
      ALTER TABLE publication_plans ADD COLUMN identity TEXT;
      CREATE UNIQUE INDEX publication_identity ON publication_plans(kind,ownerId,identity) WHERE identity IS NOT NULL;
      CREATE TABLE publication_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL REFERENCES publication_jobs(id),stepKey TEXT NOT NULL,
        operation TEXT NOT NULL,attempt INTEGER NOT NULL,outcome TEXT NOT NULL,requestHash TEXT NOT NULL,
        result TEXT,error TEXT,createdAt INTEGER NOT NULL,completedAt INTEGER,retryAllowed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(jobId,stepKey,attempt)
      ); CREATE INDEX publication_steps_job ON publication_steps(jobId,id);
      UPDATE publication_delivery_schema SET version=3 WHERE id=1;`);
    if (version < 4)
      db.exec(`CREATE TABLE publication_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL REFERENCES publication_jobs(id),
        actor TEXT NOT NULL,fingerprint TEXT NOT NULL,createdAt INTEGER NOT NULL,resume INTEGER NOT NULL,details TEXT NOT NULL
      ); CREATE INDEX confirmations_by_job ON publication_confirmations(jobId,id);
      UPDATE publication_delivery_schema SET version=4 WHERE id=1;`);
    if (version < 5)
      db.exec(`ALTER TABLE publication_jobs ADD COLUMN nextRunAt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE publication_steps ADD COLUMN replacedBy INTEGER REFERENCES publication_steps(id);
      CREATE TABLE publication_observations (
        jobId TEXT NOT NULL REFERENCES publication_jobs(id),observationKey TEXT NOT NULL,
        requestHash TEXT NOT NULL,result TEXT NOT NULL,observedAt INTEGER NOT NULL,
        PRIMARY KEY(jobId,observationKey)
      ); UPDATE publication_delivery_schema SET version=5 WHERE id=1;`);
    if (version < 6)
      db.exec(`CREATE TABLE publication_cancellations (
        jobId TEXT PRIMARY KEY REFERENCES publication_jobs(id),actor TEXT NOT NULL,requestedAt INTEGER NOT NULL
      ); UPDATE publication_delivery_schema SET version=6 WHERE id=1;`);
    if (version < 7)
      db.exec(`CREATE TABLE publication_recovery_evidence (
        id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES publication_jobs(id),
        stepId INTEGER NOT NULL REFERENCES publication_steps(id),actor TEXT NOT NULL,
        fingerprint TEXT NOT NULL,requestHash TEXT NOT NULL,stateToken TEXT NOT NULL,
        observedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,
        result TEXT NOT NULL,details TEXT NOT NULL
      ); CREATE INDEX recovery_by_job ON publication_recovery_evidence(jobId,stepId);
      CREATE TABLE publication_resolutions (
        stepId INTEGER PRIMARY KEY REFERENCES publication_steps(id),
        evidenceId TEXT NOT NULL UNIQUE REFERENCES publication_recovery_evidence(id),
        actor TEXT NOT NULL,decidedAt INTEGER NOT NULL,decision TEXT NOT NULL
      ); UPDATE publication_delivery_schema SET version=7 WHERE id=1;`);
    if (version < 8)
      db.exec(`CREATE TABLE publication_successors (
        parentId TEXT NOT NULL UNIQUE REFERENCES publication_jobs(id),
        childId TEXT PRIMARY KEY REFERENCES publication_jobs(id),
        actor TEXT NOT NULL,createdAt INTEGER NOT NULL,fingerprint TEXT NOT NULL,stateToken TEXT NOT NULL,
        CHECK(parentId<>childId)
      ); UPDATE publication_delivery_schema SET version=8 WHERE id=1;`);
    if (version < 9)
      db.exec(`ALTER TABLE publication_plans ADD COLUMN sourceProjectId TEXT;
      CREATE INDEX publications_by_source ON publication_plans(kind,ownerId,sourceProjectId,spaceId);
      UPDATE publication_delivery_schema SET version=9 WHERE id=1;`);
  }).immediate();
}
