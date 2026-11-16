import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
export const settingsMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_visibility_meta",
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "revision", type: "bigint", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  },
  {
    name: "panda_force_hidden_projects",
    columns: [
      { name: "pathHash", type: "char(64)", nullable: false },
      { name: "path", type: "text", nullable: false },
      { name: "hiddenAt", type: "bigint", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["pathHash"] }],
  },
];
export const mysqlSettingsModule = mysqlModelModule("settings", settingsMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
