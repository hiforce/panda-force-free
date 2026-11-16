import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApplicationDatabaseRegistry } from "../../src/server/database/application-registry.js";
import { migrationChecksum } from "../../src/server/database/registry.js";

/** Exports registered versions only. Missing runtime domains remain visible in readiness, never invented as empty tables. */
const write = process.argv.includes("--write"),
  root = join(import.meta.dir, "../../docs/database");
if (write) await mkdir(root, { recursive: true });
let count = 0;
for (const module of createApplicationDatabaseRegistry().ordered()) {
  for (const migration of module.migrations.mysql ?? []) {
    const content =
      `-- PandaForce module ${module.id}; MySQL schema version ${migration.version}.\n-- Registry checksum: ${migrationChecksum(module.id, migration)}\n-- Additive DDL only; unrelated tables and existing data are preserved.\n\n` +
      migration.steps.map((s) => `-- ${s.id}\n${s.sql.replace(/;\s*$/, "")};\n`).join("\n");
    const path = join(root, `mysql-${module.id}-v${migration.version}.sql`);
    let previous: string | null = null;
    try {
      previous = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous !== null && previous !== content)
      throw Error(`Published DDL version changed: ${module.id}/${migration.version}`);
    if (previous === null) {
      if (!write) throw Error(`Missing DDL export: ${module.id}/${migration.version}`);
      await writeFile(path, content, { flag: "wx" });
    }
    count++;
  }
}
console.log(
  `Verified ${count} registered MySQL DDL versions. Whole-application cutover still requires every runtime backend and importer.`,
);
