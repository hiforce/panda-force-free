import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
export const gadgetMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_gadget_workspace_controls",
    columns: [{ name: "id", type: "char(64)", nullable: false }],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_gadget_workspaces",
    columns: [
      { name: "owner", type: "varchar(191)", nullable: false },
      { name: "revision", type: "bigint", nullable: false },
      { name: "data", type: "longtext", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["owner"] }],
  },
  {
    name: "panda_force_gadget_workspace_operations",
    columns: [
      { name: "seq", type: "bigint unsigned", nullable: false, autoIncrement: true },
      { name: "owner", type: "varchar(191)", nullable: false },
      { name: "id", type: "varchar(191)", nullable: false },
      { name: "request", type: "longtext", nullable: false },
      { name: "receipt", type: "longtext", nullable: false },
      { name: "createdAt", type: "bigint", nullable: false },
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["owner", "id"] },
      { name: "gadget_workspace_operation_seq", unique: true, columns: ["seq"] },
      { name: "gadget_workspace_recent", unique: false, columns: ["owner", "seq"] },
    ],
  },
];
export const mysqlGadgetModule = mysqlModelModule("gadgets", gadgetMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
