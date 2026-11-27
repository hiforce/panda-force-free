import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
const text = (name: string, size?: number) => ({ name, type: size ? `varchar(${size})` : "text", nullable: false });
const integer = (name: string) => ({ name, type: "bigint", nullable: false });
const primary = (...columns: string[]) => ({ name: "PRIMARY", unique: true, columns });
const initialModels: readonly MySQLModel[] = [
  { name: "panda_force_catalog_meta", columns: [integer("id"), integer("revision")], indexes: [primary("id")] },
  {
    name: "panda_force_projects",
    columns: [
      text("id", 128),
      { ...text("code", 64), collation: "utf8mb4_general_ci" },
      text("name", 100),
      text("description"),
      integer("created_at"),
      integer("updated_at"),
    ],
    indexes: [
      primary("id"),
      { name: "project_code", unique: true, columns: ["code"] },
      { name: "projects_created", unique: false, columns: ["created_at", "id"] },
    ],
  },
  {
    name: "panda_force_session_projects",
    columns: [text("session_id", 128), text("project_id", 128), text("name", 500), text("cwd"), integer("updated_at")],
    indexes: [primary("session_id"), { name: "session_projects_by_project", unique: false, columns: ["project_id"] }],
  },
  {
    name: "panda_force_project_workspaces",
    columns: [
      text("projectId", 128),
      text("code", 64),
      text("root"),
      text("path"),
      text("pathHash", 64),
      text("ownerId", 64),
      text("state", 16),
    ],
    indexes: [
      primary("projectId"),
      { name: "workspace_path", unique: true, columns: ["pathHash"] },
      { name: "workspace_owner", unique: true, columns: ["ownerId"] },
    ],
  },
  {
    name: "panda_force_project_workspace_creations",
    columns: [text("operationId", 128), text("requestHash", 64), text("projectId", 128)],
    indexes: [primary("operationId")],
  },
  {
    name: "panda_force_project_document_storage",
    columns: [text("project_id", 128), text("storage", 16), integer("created_at")],
    indexes: [primary("project_id")],
  },
];
const checkpoints: MySQLModel = {
  name: "panda_force_session_project_checkpoints",
  columns: [text("session_id", 128), integer("through_bytes"), integer("through_seq")],
  indexes: [primary("session_id")],
};
export const projectMySQLModels = [...initialModels, checkpoints];
const latest = mysqlModelModule("projects", projectMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
export const mysqlProjectsModule = {
  ...latest,
  migrations: {
    mysql: [
      { version: 1, steps: latest.migrations.mysql![0]!.steps.filter(({ id }) => id !== checkpoints.name) },
      { version: 2, steps: [latest.migrations.mysql![0]!.steps.find(({ id }) => id === checkpoints.name)!] },
    ],
  },
};
