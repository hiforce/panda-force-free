import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateDatabaseFile } from "../database/config.js";
import { projectVisibilityState } from "./visibility-records.js";
import { visibilityPathHash } from "./mysql-project-visibility.js";
import { migrateSQLiteModule, type MigrationTable } from "../database/data-migration.js";
import { settingsMySQLModels } from "../database/modules/settings.js";
export async function captureVisibilitySnapshot(options: { directory: string; path?: string }) {
  let value = { revision: 0, hiddenProjects: {} };
  if (options.path) {
    try {
      value = projectVisibilityState(
        JSON.parse((await readPrivateDatabaseFile(options.path, 4 * 1024 * 1024, false)).toString("utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, "settings-" + randomUUID() + ".sqlite"),
    file = await open(path, "wx", 0o600);
  await file.close();
  const db = new Database(path, { create: false, strict: true });
  try {
    db.transaction(() => {
      db.exec(
        "CREATE TABLE visibility_meta(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);CREATE TABLE hidden_projects(pathHash TEXT PRIMARY KEY,path TEXT NOT NULL,hiddenAt INTEGER NOT NULL)",
      );
      db.query("INSERT INTO visibility_meta VALUES(1,?)").run(value.revision);
      for (const [key, entry] of Object.entries(value.hiddenProjects))
        db.query("INSERT INTO hidden_projects VALUES(?,?,?)").run(
          visibilityPathHash(key),
          key,
          (entry as { hiddenAt: number }).hiddenAt,
        );
    }).immediate();
    db.close();
    return path;
  } catch (error) {
    db.close();
    await rm(path, { force: true });
    throw error;
  }
}
const tables: readonly MigrationTable[] = settingsMySQLModels.map((m) => ({
  source: m.name.slice("panda_force_".length),
  target: m.name,
  columns: m.columns.map((c) => c.name),
  sourceKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  targetKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
  project: (r) => m.columns.map((c) => r[c.name] ?? null),
}));
export const migrateSettingsSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, module: "settings", converterVersion: 1, tables });
