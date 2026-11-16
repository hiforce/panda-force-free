import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
const text = (name: string, size?: number) => ({ name, type: size ? `varchar(${size})` : "longtext", nullable: false });
const integer = (name: string) => ({ name, type: "bigint", nullable: false });
const primary = (...columns: string[]) => ({ name: "PRIMARY", unique: true, columns });
export const skillMySQLModels: readonly MySQLModel[] = [
  { name: "panda_force_skill_registry", columns: [integer("id"), integer("revision")], indexes: [primary("id")] },
  {
    name: "panda_force_skill_versions",
    columns: [
      text("id", 191),
      text("version", 64),
      text("digest", 64),
      text("manifest"),
      text("origin"),
      text("grants"),
      integer("installedAt"),
      text("installedBy", 191),
      integer("removed"),
    ],
    indexes: [primary("id", "version")],
  },
  {
    name: "panda_force_skill_exports",
    columns: [text("packageId", 191), text("version", 64), text("id", 191), integer("enabled")],
    indexes: [primary("packageId", "version", "id")],
  },
  { name: "panda_force_skill_heads", columns: [text("id", 191), text("version", 64)], indexes: [primary("id")] },
  {
    name: "panda_force_skill_audit",
    columns: [
      { ...integer("sequence"), type: "bigint unsigned", autoIncrement: true },
      integer("revision"),
      text("action", 16),
      text("id", 191),
      text("version", 64),
      text("digest", 64),
      text("actor", 191),
      text("operationId", 191),
      integer("createdAt"),
      text("details"),
    ],
    indexes: [primary("sequence"), { name: "skill_audit_revision", unique: true, columns: ["revision"] }],
  },
  {
    name: "panda_force_skill_operations",
    columns: [
      text("id", 191),
      text("actor", 191),
      text("request", 64),
      text("packageId", 191),
      text("version", 64),
      integer("revision"),
    ],
    indexes: [primary("id")],
  },
  {
    name: "panda_force_skill_captures",
    columns: [
      text("id", 191),
      text("owner", 191),
      text("request", 64),
      text("payload"),
      text("digest", 64),
      integer("byteLength"),
      integer("createdAt"),
    ],
    indexes: [primary("id"), { name: "skill_capture_owner", unique: false, columns: ["owner", "createdAt"] }],
  },
];
export const mysqlSkillsModule = mysqlModelModule("skills", skillMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
