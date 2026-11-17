import models from "./documents-models-v1.json";
import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import { documentOwnershipMySQLModels } from "./documents-models-v2.js";
/** Version one is immutable; native files and binary blobs remain in their existing storage. */
export const documentMySQLModels: readonly MySQLModel[] = [...models, ...documentOwnershipMySQLModels];
const base = mysqlModelModule("documents", models, {
  readWrite: true,
  importFrom: ["sqlite"],
});
const ownership = mysqlModelModule("documents", documentOwnershipMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
export const mysqlDocumentsModule = {
  ...base,
  migrations: { mysql: [...base.migrations.mysql!, { ...ownership.migrations.mysql![0]!, version: 2 }] },
  async inspect(context: Parameters<typeof base.inspect>[0]) {
    return [...(await base.inspect(context)), ...(await ownership.inspect(context))];
  },
};
