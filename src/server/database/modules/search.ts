import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import versionOne from "./search-mysql-v1.json";
/** External indexes, original files, credentials and binary analyzer packages retain their existing owners. */
export const searchMySQLModels = versionOne as readonly MySQLModel[];
export const mysqlSearchModule = mysqlModelModule("search", searchMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
