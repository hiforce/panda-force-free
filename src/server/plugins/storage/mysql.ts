import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
import type { PackagePermission, PluginManifest } from "../../../shared/plugins/contracts.js";
import { pluginExportPermissions, samePluginExport, type PluginExportRef } from "../../../shared/plugins/exports.js";
import { MySQLPluginExports } from "./mysql-exports.js";
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
  FROM panda_force_plugin_versions v LEFT JOIN panda_force_plugin_heads h ON h.id=v.id`;
export class MySQLPluginRegistry extends MySQLLedger implements AsyncStore<PluginRegistryStore> {
  readonly asynchronous = true;
  private exports: MySQLPluginExports;
  constructor(pool: SQL) {
    super(pool, "panda_force_plugins_guard", ["enabled", "active", "revision", "installedAt", "sequence", "createdAt"]);
    this.exports = new MySQLPluginExports(pool);
  }
  private async installed(row: Row): Promise<InstalledPlugin> {
    return {
      ...row,
      manifest: JSON.parse(row.manifest),
      grants: JSON.parse(row.grants),
      enabled: row.enabled === 1,
      active: row.active === 1,
      exports: await this.exports.list(row.id, row.version),
    };
  }
  private async revision(): Promise<number> {
    return (await this.query<
      {
        revision: number;
      },
      []
    >("SELECT COALESCE((SELECT revision FROM panda_force_plugin_registry WHERE id=1),0) revision").get())!.revision;
  }
  async snapshot(): Promise<PluginRegistrySnapshot> {
    return this.readSnapshot(async () => {
      return {
        revision: await this.revision(),
        packages: await Promise.all(
          (await this.query<Row, []>(selection + " ORDER BY v.id,v.version").all()).map(
            async (row) => await this.installed(row),
          ),
        ),
      };
    });
  }
  async get(id: string, version: string): Promise<InstalledPlugin> {
    return this.readSnapshot(async () => {
      const row = await this.query<Row, [string, string]>(selection + " WHERE v.id=? AND v.version=?").get(id, version);
      if (!row) throw new PluginRegistryError("packageNotInstalled");
      return await this.installed(row);
    });
  }
  async install(
    manifest: PluginManifest,
    digest: string,
    selected: readonly PluginExportRef[],
    grants: readonly PackagePermission[],
    mutation: PluginMutation,
  ): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      await this.check(mutation);
      const row = await this.query<
        {
          digest: string;
        },
        [string, string]
      >("SELECT digest FROM panda_force_plugin_versions WHERE id=? AND version=?").get(manifest.id, manifest.version);
      if (row) {
        if (row.digest !== digest) throw new PluginRegistryError("immutableVersion");
        const current = await this.get(manifest.id, manifest.version);
        const additions = selected.filter((entry) => !current.exports.some((item) => samePluginExport(item, entry)));
        if (!additions.length) return current;
        const combined = [...new Set([...current.grants, ...grants])].sort();
        await this.query("UPDATE panda_force_plugin_versions SET grants=? WHERE id=? AND version=?").run(
          JSON.stringify(combined),
          manifest.id,
          manifest.version,
        );
        for (const entry of additions) {
          await this.exports.add(manifest.id, manifest.version, entry);
          if (current.enabled) await this.exports.activate(manifest.id, manifest.version, entry);
        }
        const installed = await this.get(manifest.id, manifest.version);
        await this.record("install", installed, mutation);
        return installed;
      }
      await this.query(
        "INSERT INTO panda_force_plugin_versions (id,version,digest,manifest,installedAt,installedBy,enabled,grants) VALUES (?,?,?,?,?,?,1,?)",
      ).run(
        manifest.id,
        manifest.version,
        digest,
        JSON.stringify(manifest),
        mutation.now,
        mutation.actor,
        JSON.stringify(grants),
      );
      for (const entry of selected) await this.exports.add(manifest.id, manifest.version, entry);
      await this.exports.activateAll(manifest.id, manifest.version);
      await this.query(
        `INSERT INTO panda_force_plugin_heads VALUES (?,?)
        ON DUPLICATE KEY UPDATE version=VALUES(version)`,
      ).run(manifest.id, manifest.version);
      await this.record("install", await this.get(manifest.id, manifest.version), mutation);
      return await this.get(manifest.id, manifest.version);
    });
  }
  async activate(id: string, version: string, mutation: PluginMutation): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      await this.check(mutation);
      const value = await this.get(id, version);
      if (!value.enabled) throw new PluginRegistryError("packageDisabled");
      if (!value.active || value.exports.some((entry) => entry.enabled && !entry.active)) {
        await this.query(
          `INSERT INTO panda_force_plugin_heads VALUES (?,?)
          ON DUPLICATE KEY UPDATE version=VALUES(version)`,
        ).run(id, version);
        await this.exports.activateAll(id, version);
        await this.record("activate", await this.get(id, version), mutation);
      }
      return await this.get(id, version);
    });
  }
  async setEnabled(id: string, version: string, enabled: boolean, mutation: PluginMutation): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      await this.check(mutation);
      const value = await this.get(id, version);
      if (value.enabled !== enabled) {
        await this.query("UPDATE panda_force_plugin_versions SET enabled=? WHERE id=? AND version=?").run(
          enabled ? 1 : 0,
          id,
          version,
        );
        // Disabling never silently activates a different executable version.
        if (!enabled) {
          await this.query("DELETE FROM panda_force_plugin_heads WHERE id=? AND version=?").run(id, version);
          await this.exports.deactivateAll(id, version);
        }
        await this.record(enabled ? "enable" : "disable", await this.get(id, version), mutation);
      }
      return await this.get(id, version);
    });
  }
  async setExportEnabled(
    id: string,
    version: string,
    entry: PluginExportRef,
    enabled: boolean,
    mutation: PluginMutation,
  ): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      return await this.changeExport(id, version, entry, mutation, async (current) => {
        if (current.enabled === enabled) return false;
        await this.exports.setEnabled(id, version, entry, enabled);
        return true;
      });
    });
  }
  async activateExport(
    id: string,
    version: string,
    entry: PluginExportRef,
    mutation: PluginMutation,
  ): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      return await this.changeExport(id, version, entry, mutation, async (current, value) => {
        if (!value.enabled || !current.enabled) throw new PluginRegistryError("packageDisabled");
        if (current.active) return false;
        await this.exports.activate(id, version, entry);
        return true;
      });
    });
  }
  private async changeExport(
    id: string,
    version: string,
    entry: PluginExportRef,
    mutation: PluginMutation,
    change: (current: InstalledPlugin["exports"][number], value: InstalledPlugin) => Promise<boolean>,
  ): Promise<InstalledPlugin> {
    return await this.transaction(async () => {
      await this.check(mutation);
      const value = await this.get(id, version),
        current = value.exports.find((item) => samePluginExport(item, entry));
      if (!current) throw new PluginRegistryError("exportUnavailable");
      if (pluginExportPermissions(value.manifest, [entry]).some((permission) => !value.grants.includes(permission)))
        throw new PluginRegistryError("approvalRequired");
      if (await change(current, value)) await this.record("exports", await this.get(id, version), mutation);
      return await this.get(id, version);
    });
  }
  async audit(after?: number, limit = 100): Promise<PluginAuditEvent[]> {
    return this.readSnapshot(async () => {
      if (
        (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500
      )
        throw new PluginRegistryError("reviewChanged");
      const rows = (
        await this.query<
          Omit<PluginAuditEvent, "permissions" | "exports"> & {
            permissions: string;
            exports: string;
          },
          [number, number]
        >(
          `SELECT * FROM panda_force_plugin_audit WHERE sequence>? ORDER BY sequence ${after === undefined ? "DESC" : "ASC"} LIMIT ?`,
        ).all(after ?? 0, limit)
      ).map((row) => ({ ...row, permissions: JSON.parse(row.permissions), exports: JSON.parse(row.exports) }));
      return after === undefined ? rows.reverse() : rows;
    });
  }
  private async check(mutation: PluginMutation) {
    if ((await this.revision()) !== mutation.expectedRevision) throw new PluginRegistryError("registryConflict");
  }
  private async record(action: PluginAuditEvent["action"], value: InstalledPlugin, mutation: PluginMutation) {
    await this.query(
      "INSERT INTO panda_force_plugin_registry(id,revision) VALUES(1,1) ON DUPLICATE KEY UPDATE revision=revision+1",
    ).run();
    await this.query(
      "INSERT INTO panda_force_plugin_audit (revision,action,id,version,digest,actor,permissions,createdAt,exports) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      await this.revision(),
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
