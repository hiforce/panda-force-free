import type { Database } from "bun:sqlite";
import type { InstalledPluginExport, PluginExportRef } from "../../../shared/plugins/exports.js";

/** Called inside the registry transaction; export activation does not rewrite the package head. */
export class SqlitePluginExports {
  constructor(private db: Database) {}
  list(packageId: string, version: string): InstalledPluginExport[] {
    return this.db
      .query<PluginExportRef & { enabled: number; active: number }, [string, string]>(
        `
      SELECT e.kind,e.exportId AS id,e.enabled,CASE WHEN h.version=e.version THEN 1 ELSE 0 END AS active
      FROM plugin_exports e LEFT JOIN plugin_export_heads h ON h.packageId=e.packageId AND h.kind=e.kind AND h.exportId=e.exportId
      WHERE e.packageId=? AND e.version=? ORDER BY e.kind,e.exportId
    `,
      )
      .all(packageId, version)
      .map((row) => ({ ...row, enabled: row.enabled === 1, active: row.active === 1 }));
  }
  add(packageId: string, version: string, entry: PluginExportRef) {
    this.db.query("INSERT INTO plugin_exports VALUES(?,?,?,?,1)").run(packageId, version, entry.kind, entry.id);
  }
  activate(packageId: string, version: string, entry: PluginExportRef) {
    this.db
      .query(
        `INSERT INTO plugin_export_heads VALUES(?,?,?,?) ON CONFLICT(packageId,kind,exportId) DO UPDATE SET version=excluded.version`,
      )
      .run(packageId, entry.kind, entry.id, version);
  }
  activateAll(packageId: string, version: string) {
    for (const entry of this.list(packageId, version)) if (entry.enabled) this.activate(packageId, version, entry);
  }
  setEnabled(packageId: string, version: string, entry: PluginExportRef, enabled: boolean) {
    this.db
      .query("UPDATE plugin_exports SET enabled=? WHERE packageId=? AND version=? AND kind=? AND exportId=?")
      .run(enabled ? 1 : 0, packageId, version, entry.kind, entry.id);
    if (!enabled)
      this.db
        .query("DELETE FROM plugin_export_heads WHERE packageId=? AND version=? AND kind=? AND exportId=?")
        .run(packageId, version, entry.kind, entry.id);
  }
  deactivateAll(packageId: string, version: string) {
    this.db.query("DELETE FROM plugin_export_heads WHERE packageId=? AND version=?").run(packageId, version);
  }
}
