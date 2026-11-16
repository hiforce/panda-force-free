import models from "./editorial-models-v1.json";
import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
/** Version one preserves immutable proposal/application payloads and relational durable jobs. */
export const editorialMySQLModels: readonly MySQLModel[] = models;
export const mysqlEditorialModule = mysqlModelModule("editorial", editorialMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
