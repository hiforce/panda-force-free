import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
export const harnessMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_harness_guard",
    columns: [{ name: "id", type: "int", nullable: false }],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_harness_records",
    columns: [
      { name: "id", type: "varchar(191)", nullable: false },
      { name: "kind", type: "varchar(32)", nullable: false },
      { name: "owner", type: "varchar(191)", nullable: false },
      { name: "revision", type: "bigint", nullable: false },
      { name: "data", type: "longtext", nullable: false },
      { name: "updatedAt", type: "bigint", nullable: false },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "harness_owner_kind", unique: false, columns: ["owner", "kind", "updatedAt"] },
    ],
  },
];
export const mysqlHarnessModule = mysqlModelModule("harness", harnessMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
