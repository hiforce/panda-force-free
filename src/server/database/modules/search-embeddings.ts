import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
const text = (name: string, size = 191) => ({ name, type: `varchar(${size})`, nullable: false });
const integer = (name: string) => ({ name, type: "bigint", nullable: false });
const primary = (...columns: string[]) => ({ name: "PRIMARY", unique: true, columns });
/** v1 owns durable provider admission, usage and backoff. Derived cache rows, totals and vector bytes keep their local storage owner. */
export const embeddingMySQLModels: readonly MySQLModel[] = [
  {
    name: "panda_force_embedding_locks",
    columns: [text("namespace"), text("token", 64), integer("untilAt")],
    indexes: [primary("namespace")],
  },
  {
    name: "panda_force_embedding_inflight",
    columns: [text("token", 64), text("model", 128), integer("startedAt"), integer("untilAt")],
    indexes: [primary("token"), { name: "embedding_inflight_expiry", unique: false, columns: ["untilAt"] }],
  },
  {
    name: "panda_force_embedding_usage",
    columns: [text("bucket"), integer("window"), integer("calls"), integer("characters")],
    indexes: [primary("bucket", "window")],
  },
  {
    name: "panda_force_embedding_backoff",
    columns: [text("model", 128), integer("attempts"), integer("untilAt")],
    indexes: [primary("model")],
  },
  { name: "panda_force_embedding_mutex", columns: [integer("id")], indexes: [primary("id")] },
];
export const mysqlSearchEmbeddingsModule = mysqlModelModule("search-embeddings", embeddingMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
