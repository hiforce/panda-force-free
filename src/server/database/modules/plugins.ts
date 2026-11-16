import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import models from "./plugins-mysql-v1.json";
export const pluginMySQLModels = models as readonly MySQLModel[];
// Native metadata ports and injected asynchronous consumers are verified independently of deployment.
export const mysqlPluginsModule = mysqlModelModule("plugins", models as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
