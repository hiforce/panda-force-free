import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
export const identityMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_identity_settings",
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "record", type: "longtext", nullable: false },
      { name: "revision", type: "bigint", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_identity_users",
    columns: [
      { name: "id", type: "char(36)", nullable: false },
      { name: "username", type: "varchar(254)", nullable: false },
      { name: "record", type: "longtext", nullable: false },
      { name: "revision", type: "bigint", nullable: false },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "identity_users_username", unique: true, columns: ["username"] },
    ],
  },
  {
    name: "panda_force_identity_credentials",
    columns: [
      { name: "id", type: "varchar(32)", nullable: false },
      { name: "data", type: "longtext", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_revoked_sessions",
    columns: [
      { name: "digest", type: "char(64)", nullable: false },
      { name: "expires_at", type: "bigint", nullable: false },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["digest"] },
      { name: "revoked_sessions_expiry", unique: false, columns: ["expires_at"] },
    ],
  },
];
const identity = mysqlModelModule("identity", identityMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
const accountTables = new Set(["panda_force_identity_settings", "panda_force_identity_users"]),
  shippedSteps = identity.migrations.mysql![0]!.steps;
export const mysqlIdentityModule = {
  ...identity,
  migrations: {
    mysql: [
      {
        version: 1,
        steps: shippedSteps.filter((step) => !accountTables.has(step.id)),
        historicalSteps: [shippedSteps],
      },
      { version: 2, steps: shippedSteps.filter((step) => accountTables.has(step.id)) },
    ],
  },
};
