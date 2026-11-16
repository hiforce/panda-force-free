import type { Database } from "bun:sqlite";
import { SkillRegistryError } from "../errors.js";
export function migrateSkills(db: Database): void {
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 1) throw new SkillRegistryError("unsupportedSchema");
    if (version) return;
    db.exec(`CREATE TABLE skill_registry(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT INTO skill_registry VALUES(1,0);
      CREATE TABLE skill_versions(id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,origin TEXT NOT NULL,grants TEXT NOT NULL,installedAt INTEGER NOT NULL,installedBy TEXT NOT NULL,removed INTEGER NOT NULL CHECK(removed IN (0,1)),PRIMARY KEY(id,version));
      CREATE TABLE skill_exports(packageId TEXT NOT NULL,version TEXT NOT NULL,id TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),PRIMARY KEY(packageId,version,id),FOREIGN KEY(packageId,version) REFERENCES skill_versions(id,version));
      CREATE TABLE skill_heads(id TEXT PRIMARY KEY,version TEXT NOT NULL,FOREIGN KEY(id,version) REFERENCES skill_versions(id,version));
      CREATE TABLE skill_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL UNIQUE,action TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,actor TEXT NOT NULL,operationId TEXT NOT NULL,createdAt INTEGER NOT NULL,details TEXT NOT NULL);
      CREATE TABLE skill_operations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,request TEXT NOT NULL,packageId TEXT NOT NULL,version TEXT NOT NULL,revision INTEGER NOT NULL,FOREIGN KEY(packageId,version) REFERENCES skill_versions(id,version));
      CREATE TABLE skill_captures(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,byteLength INTEGER NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX skill_capture_owner ON skill_captures(owner,createdAt);
      PRAGMA user_version=1;`);
  }).immediate();
}
