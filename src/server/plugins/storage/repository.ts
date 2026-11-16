import type { Database } from "bun:sqlite";
import type { PackagePermission, PluginManifest } from "../../../shared/plugins/contracts.js";
import { pluginExportPermissions, samePluginExport, type PluginExportRef } from "../../../shared/plugins/exports.js";
import { SqlitePluginExports } from "./exports.js";
import { PluginRegistryError } from "../errors.js";
import type {
  InstalledPlugin,
  PluginAuditEvent,
  PluginMutation,
  PluginRegistrySnapshot,
  PluginRegistryStore,
} from "../ports.js";

type Row = Omit<InstalledPlugin, "manifest" | "enabled" | "active" | "exports" | "grants"> & {
  manifest: string;
  grants: string;
  enabled: number;
  active: number;
};
const selection = `SELECT v.*, CASE WHEN h.version=v.version THEN 1 ELSE 0 END AS active
  FROM plugin_versions v LEFT JOIN plugin_heads h ON h.id=v.id`;
export class SqlitePluginRegistry implements PluginRegistryStore {
  private exports: SqlitePluginExports;
  constructor(private db: Database) {
    this.exports = new SqlitePluginExports(db);
  }
  private installed(row: Row): InstalledPlugin {
    return {
      ...row,
      manifest: JSON.parse(row.manifest),
      grants: JSON.parse(row.grants),
      enabled: row.enabled === 1,
      active: row.active === 1,
      exports: this.exports.list(row.id, row.version),
    };
  }
  private revision(): number {
    return this.db.query<{ revision: number }, []>("SELECT revision FROM plugin_registry WHERE id=1").get()!.revision;
  }
  snapshot(): PluginRegistrySnapshot {
    return this.db.transaction(() => ({
      revision: this.revision(),
      packages: this.db
        .query<Row, []>(selection + " ORDER BY v.id,v.version")
        .all()
        .map((row) => this.installed(row)),
    }))();
  }
  get(id: string, version: string): InstalledPlugin {
    return this.db.transaction(() => {
      const row = this.db.query<Row, [string, string]>(selection + " WHERE v.id=? AND v.version=?").get(id, version);
      if (!row) throw new PluginRegistryError("packageNotInstalled");
      return this.installed(row);
    })();
  }
  install(
    manifest: PluginManifest,
    digest: string,
    selected: readonly PluginExportRef[],
    grants: readonly PackagePermission[],
    mutation: PluginMutation,
  ): InstalledPlugin {
    return this.db
      .transaction(() => {
        this.check(mutation);
        const row = this.db
          .query<{ digest: string }, [string, string]>("SELECT digest FROM plugin_versions WHERE id=? AND version=?")
          .get(manifest.id, manifest.version);
        if (row) {
          if (row.digest !== digest) throw new PluginRegistryError("immutableVersion");
          const current = this.get(manifest.id, manifest.version);
          const additions = selected.filter((entry) => !current.exports.some((item) => samePluginExport(item, entry)));
          if (!additions.length) return current;
          const combined = [...new Set([...current.grants, ...grants])].sort();
          this.db
            .query("UPDATE plugin_versions SET grants=? WHERE id=? AND version=?")
            .run(JSON.stringify(combined), manifest.id, manifest.version);
          for (const entry of additions) {
            this.exports.add(manifest.id, manifest.version, entry);
            if (current.enabled) this.exports.activate(manifest.id, manifest.version, entry);
          }
          const installed = this.get(manifest.id, manifest.version);
          this.record("install", installed, mutation);
          return installed;
        }
        this.db
          .query(
            "INSERT INTO plugin_versions (id,version,digest,manifest,installedAt,installedBy,enabled,grants) VALUES (?,?,?,?,?,?,1,?)",
          )
          .run(
            manifest.id,
            manifest.version,
            digest,
            JSON.stringify(manifest),
            mutation.now,
            mutation.actor,
            JSON.stringify(grants),
          );
        for (const entry of selected) this.exports.add(manifest.id, manifest.version, entry);
        this.exports.activateAll(manifest.id, manifest.version);
        this.db
          .query(
            `INSERT INTO plugin_heads VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version`,
          )
          .run(manifest.id, manifest.version);
        this.record("install", this.get(manifest.id, manifest.version), mutation);
        return this.get(manifest.id, manifest.version);
      })
      .immediate();
  }
  activate(id: string, version: string, mutation: PluginMutation): InstalledPlugin {
    return this.db
      .transaction(() => {
        this.check(mutation);
        const value = this.get(id, version);
        if (!value.enabled) throw new PluginRegistryError("packageDisabled");
        if (!value.active || value.exports.some((entry) => entry.enabled && !entry.active)) {
          this.db
            .query(
              `INSERT INTO plugin_heads VALUES (?,?)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version`,
            )
            .run(id, version);
          this.exports.activateAll(id, version);
          this.record("activate", this.get(id, version), mutation);
        }
        return this.get(id, version);
      })
      .immediate();
  }
  setEnabled(id: string, version: string, enabled: boolean, mutation: PluginMutation): InstalledPlugin {
    return this.db
      .transaction(() => {
        this.check(mutation);
        const value = this.get(id, version);
        if (value.enabled !== enabled) {
          this.db
            .query("UPDATE plugin_versions SET enabled=? WHERE id=? AND version=?")
            .run(enabled ? 1 : 0, id, version);
          // Disabling never silently activates a different executable version.
          if (!enabled) {
            this.db.query("DELETE FROM plugin_heads WHERE id=? AND version=?").run(id, version);
            this.exports.deactivateAll(id, version);
          }
          this.record(enabled ? "enable" : "disable", this.get(id, version), mutation);
        }
        return this.get(id, version);
      })
      .immediate();
  }
  setExportEnabled(
    id: string,
    version: string,
    entry: PluginExportRef,
    enabled: boolean,
    mutation: PluginMutation,
  ): InstalledPlugin {
    return this.changeExport(id, version, entry, mutation, (current) => {
      if (current.enabled === enabled) return false;
      this.exports.setEnabled(id, version, entry, enabled);
      return true;
    });
  }
  activateExport(id: string, version: string, entry: PluginExportRef, mutation: PluginMutation): InstalledPlugin {
    return this.changeExport(id, version, entry, mutation, (current, value) => {
      if (!value.enabled || !current.enabled) throw new PluginRegistryError("packageDisabled");
      if (current.active) return false;
      this.exports.activate(id, version, entry);
      return true;
    });
  }
  private changeExport(
    id: string,
    version: string,
    entry: PluginExportRef,
    mutation: PluginMutation,
    change: (current: InstalledPlugin["exports"][number], value: InstalledPlugin) => boolean,
  ): InstalledPlugin {
    return this.db
      .transaction(() => {
        this.check(mutation);
        const value = this.get(id, version),
          current = value.exports.find((item) => samePluginExport(item, entry));
        if (!current) throw new PluginRegistryError("exportUnavailable");
        if (pluginExportPermissions(value.manifest, [entry]).some((permission) => !value.grants.includes(permission)))
          throw new PluginRegistryError("approvalRequired");
        if (change(current, value)) this.record("exports", this.get(id, version), mutation);
        return this.get(id, version);
      })
      .immediate();
  }
  audit(after?: number, limit = 100): PluginAuditEvent[] {
    if (
      (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new PluginRegistryError("reviewChanged");
    const rows = this.db
      .query<
        Omit<PluginAuditEvent, "permissions" | "exports"> & { permissions: string; exports: string },
        [number, number]
      >(`SELECT * FROM plugin_audit WHERE sequence>? ORDER BY sequence ${after === undefined ? "DESC" : "ASC"} LIMIT ?`)
      .all(after ?? 0, limit)
      .map((row) => ({ ...row, permissions: JSON.parse(row.permissions), exports: JSON.parse(row.exports) }));
    return after === undefined ? rows.reverse() : rows;
  }
  private check(mutation: PluginMutation) {
    if (this.revision() !== mutation.expectedRevision) throw new PluginRegistryError("registryConflict");
  }
  private record(action: PluginAuditEvent["action"], value: InstalledPlugin, mutation: PluginMutation) {
    this.db.query("UPDATE plugin_registry SET revision=revision+1 WHERE id=1").run();
    this.db
      .query(
        "INSERT INTO plugin_audit (revision,action,id,version,digest,actor,permissions,createdAt,exports) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        this.revision(),
        action,
        value.id,
        value.version,
        value.digest,
        mutation.actor,
        JSON.stringify(value.grants),
        mutation.now,
        JSON.stringify(value.exports),
      );
  }
}
