import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import models from "./builds-mysql-v1.json";
export const buildMySQLModels = models as readonly MySQLModel[];
// Native metadata ports and injected asynchronous consumers are verified independently of deployment.
export const mysqlBuildsModule = mysqlModelModule("builds", models as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
