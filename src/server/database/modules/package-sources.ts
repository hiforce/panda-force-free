import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import models from "./package-sources-mysql-v1.json";
export const packageSourceMySQLModels = models as readonly MySQLModel[];
// Native metadata ports and injected asynchronous consumers are verified independently of deployment.
export const mysqlPackageSourcesModule = mysqlModelModule("package-sources", models as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
