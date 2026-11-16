import models from "./documents-models-v1.json";
import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
/** Version one is immutable; native files and binary blobs remain in their existing storage. */
export const documentMySQLModels: readonly MySQLModel[] = models;
export const mysqlDocumentsModule = mysqlModelModule("documents", documentMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
