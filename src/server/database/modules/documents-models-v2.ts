import type { MySQLModel } from "../mysql-model.js";

export const documentOwnershipMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_document_ownership_records",
    columns: [
      { name: "spaceId", type: "varchar(128)", nullable: false },
      { name: "documentId", type: "varchar(128)", nullable: false },
      { name: "record", type: "longtext", nullable: false },
    ],
    indexes: [{ name: "PRIMARY", unique: true, columns: ["spaceId", "documentId"] }],
  },
];
