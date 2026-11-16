import type { DatabaseModule, SchemaIssue } from "../registry.js";
import { createMySQLTable, modelDefinition, type MySQLModel } from "../mysql-model.js";
import { inspectTable } from "../schema-inspection.js";

export const applicationInstallationModel: MySQLModel = {
  name: "panda_force_database_installation",
  columns: [
    { name: "id", type: "int", nullable: false },
    { name: "installationId", type: "char(36)", nullable: false },
    { name: "operationId", type: "char(36)", nullable: false },
    { name: "state", type: "varchar(16)", nullable: false },
    { name: "targetHash", type: "char(64)", nullable: false },
    { name: "updatedAt", type: "bigint", nullable: false },
  ],
  indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
};

const tables = [
  {
    name: "panda_force_data_migration_runs",
    sql: "CREATE TABLE IF NOT EXISTS panda_force_data_migration_runs(id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,module VARCHAR(48) COLLATE utf8mb4_bin NOT NULL,sourceHash CHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,createdAt BIGINT NOT NULL,updatedAt BIGINT NOT NULL,PRIMARY KEY(id,module),UNIQUE KEY migration_module(module)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
  },
  {
    name: "panda_force_data_migration_tables",
    sql: "CREATE TABLE IF NOT EXISTS panda_force_data_migration_tables(migrationId VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,module VARCHAR(48) COLLATE utf8mb4_bin NOT NULL,tableName VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,cursorValue BIGINT NOT NULL,rowsCopied BIGINT NOT NULL,checksum CHAR(64),state VARCHAR(16) NOT NULL,updatedAt BIGINT NOT NULL,PRIMARY KEY(migrationId,module,tableName)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
  },
];
export const mysqlDataMigrationModule: DatabaseModule = {
  id: "data-migrations",
  dependencies: [],
  backends: { mysql: { readWrite: true, importFrom: ["sqlite"] } },
  migrations: {
    mysql: [
      { version: 1, steps: tables.map((t) => ({ id: t.name, sql: t.sql, satisfied: (c) => c.table(t.name) })) },
      {
        version: 2,
        steps: [
          {
            id: "mapping-fingerprint",
            sql: "ALTER TABLE panda_force_data_migration_runs ADD COLUMN mappingHash CHAR(64) COLLATE utf8mb4_bin NULL",
            satisfied: (c) => c.column("panda_force_data_migration_runs", "mappingHash"),
          },
        ],
      },
      {
        version: 3,
        steps: [
          {
            id: applicationInstallationModel.name,
            sql: createMySQLTable(applicationInstallationModel),
            satisfied: (c) => c.table(applicationInstallationModel.name),
          },
        ],
      },
    ],
  },
  async inspect(c) {
    const issues: SchemaIssue[] = [];
    for (const table of tables)
      if (!(await c.table(table.name)))
        issues.push({ module: "data-migrations", object: table.name, code: "missingTable" as const });
    if ((await c.table(tables[0]!.name)) && !(await c.column(tables[0]!.name, "mappingHash")))
      issues.push({ module: "data-migrations", object: "mappingHash", code: "missingColumn" });
    issues.push(...(await inspectTable(c, "data-migrations", modelDefinition(applicationInstallationModel))));
    return issues;
  },
};
