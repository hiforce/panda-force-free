import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import models from "./templates-mysql-v1.json";
import previews from "./templates-mysql-v2.json";
export const templateMySQLModels = [...models, ...previews] as readonly MySQLModel[];
// Native metadata ports and injected asynchronous consumers are verified independently of deployment.
const base = mysqlModelModule("templates", models as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
const previewModule = mysqlModelModule("templates", previews as readonly MySQLModel[], {
  readWrite: true,
  importFrom: ["sqlite"],
});
export const mysqlTemplatesModule = {
  ...base,
  migrations: { mysql: [...base.migrations.mysql!, { ...previewModule.migrations.mysql![0]!, version: 2 }] },
  async inspect(context: Parameters<typeof base.inspect>[0]) {
    return [...(await base.inspect(context)), ...(await previewModule.inspect(context))];
  },
};
