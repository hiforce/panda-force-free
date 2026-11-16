import type { SQL } from "bun";
import { ProjectCatalog } from "../projects/catalog.js";
import { ProjectDocumentStorage } from "../projects/document-storage.js";
import type { ApplicationConfig, ApplicationStores } from "./types.js";

/** Select related project adapters together so a native catalog never opens a fallback SQLite writer. */
export function createApplicationProjects(
  config: ApplicationConfig,
  sql: SQL | null,
  stores: ApplicationStores | null,
) {
  if (stores) {
    if (!sql) throw new Error("Project persistence selection is inconsistent");
    return { driver: "mysql" as const, sql, stores, catalog: stores.projectCatalog, storage: stores.documentStorage };
  }
  if (sql) throw new Error("Project persistence selection is inconsistent");
  const catalog = new ProjectCatalog(config.projectCatalogPath);
  return { driver: "sqlite" as const, catalog, storage: new ProjectDocumentStorage(catalog.db) };
}
export type ApplicationProjects = ReturnType<typeof createApplicationProjects>;
