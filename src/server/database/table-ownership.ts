import type { DatabaseRegistry } from "./registry.js";

/** DDL registrations, rather than a database-name wildcard, define the application-owned table inventory. */
export function databaseTableOwnership(registry: DatabaseRegistry) {
  const owners = new Map<string, string>();
  const modules = new Map<string, string[]>();
  for (const module of registry.ordered()) {
    const tables: string[] = [];
    for (const version of module.migrations.mysql ?? [])
      for (const step of version.steps) {
        const match = /^CREATE TABLE(?: IF NOT EXISTS)?\s+`?(panda_force_[a-zA-Z0-9_]+)`?\s*\(/i.exec(step.sql.trim());
        if (!match) continue;
        const name = match[1]!;
        if (name.length > 64 || (owners.has(name) && owners.get(name) !== module.id))
          throw Error("ambiguousDatabaseTableOwnership");
        if (!owners.has(name)) tables.push(name);
        owners.set(name, module.id);
      }
    modules.set(module.id, tables);
  }
  return { owners, modules };
}
