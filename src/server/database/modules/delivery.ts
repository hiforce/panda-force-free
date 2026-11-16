import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
import versionOne from "./delivery-mysql-v1.json";
/** Delivery state shares the connections transaction fence; immutable plan, snapshot and effect records retain separate relational ownership. */
export const deliveryMySQLModels = versionOne as readonly MySQLModel[];
export const mysqlDeliveryModule = {
  ...mysqlModelModule("delivery", deliveryMySQLModels, { readWrite: true, importFrom: ["sqlite"] }),
  dependencies: ["connections"],
};
