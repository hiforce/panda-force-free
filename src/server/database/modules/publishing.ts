import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import models from "./publishing-mysql-v1.json";
export const publishingMySQLModels = models as readonly MySQLModel[];
// Native metadata ports and injected asynchronous consumers are verified independently of deployment.
export const mysqlPublishingModule = mysqlModelModule("publishing", models as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
