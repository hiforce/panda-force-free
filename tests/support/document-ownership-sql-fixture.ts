import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { isolatedMySQLDatabase } from "./mysql-database.js";

export async function documentOwnershipSQLFixture(driver: "sqlite" | "mysql") {
  const root = await mkdtemp(join(tmpdir(), "panda-ownership-sql-")),
    db = driver === "mysql" ? await isolatedMySQLDatabase("ownmove") : null;
  if (db) await new DatabaseRegistry().register(mysqlDocumentsModule).upgrade(new MySQLSchemaConnection(db.sql));
  const grants = new Set(["project-1", "project-2"]),
    authorize = (id: string) => {
      if (!grants.has(id)) throw new DocumentError("notFound", 404);
    },
    open = () =>
      db
        ? createMySQLDocumentFeature({ sql: db.sql, stateRoot: root, allowedRoots: [root], requireProject: authorize })
        : createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject: authorize });
  let feature = open();
  const services = () => feature.transfers;
  return {
    root,
    grants,
    feature: () => feature,
    services,
    authorize,
    reopen() {
      if (driver === "sqlite") (feature.persistence as Database).close();
      feature = open();
    },
    async close() {
      if (driver === "sqlite") (feature.persistence as Database).close();
      await db?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
