import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import versionOne from "./knowledge-mysql-v1.json";
/** Versioned relational definitions are immutable migration inputs, independent of current SQLite schema code. */
export const knowledgeMySQLModels = versionOne as readonly MySQLModel[];
export const mysqlKnowledgeModule = mysqlModelModule("knowledge", knowledgeMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
