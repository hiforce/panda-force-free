import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
const string = (name: string, size = 128, nullable = false) => ({ name, type: `varchar(${size})`, nullable });
const integer = (name: string) => ({ name, type: "bigint", nullable: false });
const primary = (...columns: string[]) => ({ name: "PRIMARY", unique: true, columns });
const projectOwners = {
  name: "panda_force_content_access_project_owners",
  columns: [string("project"), string("owner", 64)],
  indexes: [primary("project")],
} satisfies MySQLModel;
const originalModels: readonly MySQLModel[] = [
  { name: "panda_force_content_access_meta", columns: [integer("id"), integer("revision")], indexes: [primary("id")] },
  {
    name: "panda_force_content_access_grants",
    columns: [string("project"), string("owner", 64), string("role", 16), integer("updatedAt")],
    indexes: [
      primary("project", "owner"),
      { name: "content_access_by_owner", unique: false, columns: ["owner", "project"] },
    ],
  },
  {
    name: "panda_force_content_access_changes",
    columns: [
      integer("revision"),
      string("project"),
      string("owner", 64),
      string("role", 16, true),
      string("actor", 64),
      integer("createdAt"),
    ],
    indexes: [primary("revision")],
  },
];
export const contentAccessMySQLModels = [...originalModels, projectOwners];
const latest = mysqlModelModule("content-access", contentAccessMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
const steps = latest.migrations.mysql![0]!.steps;
export const mysqlContentAccessModule = {
  ...latest,
  migrations: {
    mysql: [
      { version: 1, steps: steps.filter(({ id }) => id !== projectOwners.name) },
      { version: 2, steps: steps.filter(({ id }) => id === projectOwners.name) },
    ],
  },
  dependencies: ["projects"],
};
