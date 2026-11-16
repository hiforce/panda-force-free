import type { SQL } from "bun";
import { MySQLLedger } from "../../packages/mysql-ledger.js";
import type { InstalledPluginExport, PluginExportRef } from "../../../shared/plugins/exports.js";
/** Called inside the registry transaction; export activation does not rewrite the package head. */
export class MySQLPluginExports extends MySQLLedger {
  constructor(pool: SQL) {
    super(pool, "panda_force_plugins_guard", ["enabled", "active"]);
  }
  async list(packageId: string, version: string): Promise<InstalledPluginExport[]> {
    return this.readSnapshot(async () => {
      return (
        await this.query<
          PluginExportRef & {
            enabled: number;
            active: number;
          },
          [string, string]
        >(
          `
      SELECT e.kind,e.exportId AS id,e.enabled,CASE WHEN h.version=e.version THEN 1 ELSE 0 END AS active
      FROM panda_force_plugin_exports e LEFT JOIN panda_force_plugin_export_heads h ON h.packageId=e.packageId AND h.kind=e.kind AND h.exportId=e.exportId
      WHERE e.packageId=? AND e.version=? ORDER BY e.kind,e.exportId
    `,
        ).all(packageId, version)
      ).map((row) => ({ ...row, enabled: row.enabled === 1, active: row.active === 1 }));
    });
  }
  async add(packageId: string, version: string, entry: PluginExportRef) {
    return this.transaction(async () => {
      await this.query("INSERT INTO panda_force_plugin_exports VALUES(?,?,?,?,1)").run(
        packageId,
        version,
        entry.kind,
        entry.id,
      );
    });
  }
  async activate(packageId: string, version: string, entry: PluginExportRef) {
    return this.transaction(async () => {
      await this.query(
        `INSERT INTO panda_force_plugin_export_heads VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version)`,
      ).run(packageId, entry.kind, entry.id, version);
    });
  }
  async activateAll(packageId: string, version: string) {
    return this.transaction(async () => {
      for (const entry of await this.list(packageId, version))
        if (entry.enabled) await this.activate(packageId, version, entry);
    });
  }
  async setEnabled(packageId: string, version: string, entry: PluginExportRef, enabled: boolean) {
    return this.transaction(async () => {
      await this.query(
        "UPDATE panda_force_plugin_exports SET enabled=? WHERE packageId=? AND version=? AND kind=? AND exportId=?",
      ).run(enabled ? 1 : 0, packageId, version, entry.kind, entry.id);
      if (!enabled)
        await this.query(
          "DELETE FROM panda_force_plugin_export_heads WHERE packageId=? AND version=? AND kind=? AND exportId=?",
        ).run(packageId, version, entry.kind, entry.id);
    });
  }
  async deactivateAll(packageId: string, version: string) {
    return this.transaction(async () => {
      await this.query("DELETE FROM panda_force_plugin_export_heads WHERE packageId=? AND version=?").run(
        packageId,
        version,
      );
    });
  }
}
