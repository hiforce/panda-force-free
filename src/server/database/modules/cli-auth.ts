import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
export const cliMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_cli_control",
    columns: [{ name: "id", type: "char(64)", nullable: false }],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_cli_clients",
    columns: [
      { name: "id", type: "varchar(64)", nullable: false },
      { name: "owner", type: "varchar(191)", nullable: false },
      { name: "name", type: "varchar(80)", nullable: false },
      { name: "kind", type: "varchar(16)", nullable: false },
      { name: "createdAt", type: "bigint", nullable: false },
      { name: "revokedAt", type: "bigint", nullable: true },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "cli_clients_owner", unique: false, columns: ["owner", "createdAt"] },
    ],
  },
  {
    name: "panda_force_cli_keys",
    columns: [
      { name: "keyId", type: "char(24)", nullable: false },
      { name: "clientId", type: "varchar(64)", nullable: false },
      { name: "owner", type: "varchar(191)", nullable: false },
      { name: "digest", type: "char(64)", nullable: false },
      { name: "projects", type: "text", nullable: false },
      { name: "capabilities", type: "text", nullable: false },
      { name: "expiresAt", type: "bigint", nullable: false },
      { name: "createdAt", type: "bigint", nullable: false },
      { name: "revokedAt", type: "bigint", nullable: true },
      { name: "lastUsedAt", type: "bigint", nullable: true },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["keyId"] },
      { name: "cli_keys_client", unique: true, columns: ["clientId"] },
      { name: "cli_keys_owner", unique: false, columns: ["owner", "createdAt"] },
    ],
  },
];
export const mysqlCliAuthModule = mysqlModelModule("cli-auth", cliMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
