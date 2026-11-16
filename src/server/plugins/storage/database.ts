import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { PluginRegistryError } from "../errors.js";
import type { PluginManifest } from "../../../shared/plugins/contracts.js";
import { pluginExports } from "../../../shared/plugins/exports.js";

/** Plugin state has a separate lifecycle from documents, builds and publication receipts. */
export function openPluginDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 4) throw new PluginRegistryError("unsupportedSchema");
      if (!version)
        db.exec(`
        CREATE TABLE plugin_registry (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT INTO plugin_registry VALUES (1,0);
        CREATE TABLE plugin_versions (
          id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,
          installedAt INTEGER NOT NULL,installedBy TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          PRIMARY KEY(id,version)
        );
        CREATE TABLE plugin_heads (
          id TEXT PRIMARY KEY,version TEXT NOT NULL,
          FOREIGN KEY(id,version) REFERENCES plugin_versions(id,version)
        );
        CREATE TABLE plugin_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL UNIQUE,
          action TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,
          actor TEXT NOT NULL,permissions TEXT NOT NULL,createdAt INTEGER NOT NULL,
          FOREIGN KEY(id,version) REFERENCES plugin_versions(id,version)
        );
        PRAGMA user_version=1;
      `);
      if (version < 2)
        db.exec(`
        CREATE TABLE template_drafts (
          id TEXT PRIMARY KEY,revision INTEGER NOT NULL,definition TEXT NOT NULL,digest TEXT NOT NULL,
          packageDigest TEXT NOT NULL,validation TEXT,publishedAt INTEGER,updatedAt INTEGER NOT NULL,updatedBy TEXT NOT NULL
        );
        CREATE TABLE template_releases (
          id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,packageDigest TEXT NOT NULL,
          definition TEXT NOT NULL,validation TEXT NOT NULL,publishedAt INTEGER NOT NULL,publishedBy TEXT NOT NULL,
          PRIMARY KEY(id,version),FOREIGN KEY(id,version) REFERENCES plugin_versions(id,version)
        );
        CREATE TABLE template_library_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,draftId TEXT NOT NULL,revision INTEGER NOT NULL,
          action TEXT NOT NULL,digest TEXT NOT NULL,actor TEXT NOT NULL,createdAt INTEGER NOT NULL
        );
        PRAGMA user_version=2;
      `);
      if (version < 3)
        db.exec(`
        CREATE TABLE site_sample_runs (
          id TEXT PRIMARY KEY,owner TEXT NOT NULL,sampleKey TEXT NOT NULL,request TEXT NOT NULL,
          record TEXT NOT NULL,input TEXT,logs TEXT NOT NULL DEFAULT '',createdAt INTEGER NOT NULL,
          terminal INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX site_samples_by_owner ON site_sample_runs(owner,createdAt DESC);
        CREATE INDEX site_samples_by_key ON site_sample_runs(sampleKey,createdAt DESC);
        PRAGMA user_version=3;
      `);
      if (version < 4) {
        db.exec(`
          ALTER TABLE plugin_versions ADD COLUMN grants TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE plugin_audit ADD COLUMN exports TEXT NOT NULL DEFAULT '[]';
          CREATE TABLE plugin_exports (
            packageId TEXT NOT NULL,version TEXT NOT NULL,kind TEXT NOT NULL,exportId TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            PRIMARY KEY(packageId,version,kind,exportId),
            FOREIGN KEY(packageId,version) REFERENCES plugin_versions(id,version)
          );
          CREATE TABLE plugin_export_heads (
            packageId TEXT NOT NULL,kind TEXT NOT NULL,exportId TEXT NOT NULL,version TEXT NOT NULL,
            PRIMARY KEY(packageId,kind,exportId),
            FOREIGN KEY(packageId,version,kind,exportId) REFERENCES plugin_exports(packageId,version,kind,exportId)
          );
        `);
        // Existing whole-package approvals retain exactly their previous exports and grants.
        for (const row of db
          .query<{ id: string; version: string; manifest: string }, []>(
            "SELECT id,version,manifest FROM plugin_versions",
          )
          .all()) {
          const manifest = JSON.parse(row.manifest) as PluginManifest;
          db.query("UPDATE plugin_versions SET grants=? WHERE id=? AND version=?").run(
            JSON.stringify(manifest.permissions),
            row.id,
            row.version,
          );
          for (const entry of pluginExports(manifest))
            db.query("INSERT INTO plugin_exports VALUES(?,?,?,?,1)").run(row.id, row.version, entry.kind, entry.id);
        }
        db.exec(`
          INSERT INTO plugin_export_heads SELECT e.packageId,e.kind,e.exportId,e.version FROM plugin_exports e
          JOIN plugin_heads h ON h.id=e.packageId AND h.version=e.version
          JOIN plugin_versions v ON v.id=e.packageId AND v.version=e.version WHERE v.enabled=1;
          PRAGMA user_version=4;
        `);
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
