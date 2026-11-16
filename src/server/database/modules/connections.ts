import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import versionOne from "./connections-mysql-v1.json";
/** Version one retains explicit owner, credential, account and OAuth-consent records; master keys remain administrator-owned files. */
export const connectionMySQLModels = versionOne as readonly MySQLModel[];
export const mysqlConnectionsModule = mysqlModelModule("connections", connectionMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
