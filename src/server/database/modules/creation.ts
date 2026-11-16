import { mysqlModelModule, type MySQLModel } from "../mysql-model.js";
const t = (name: string, size?: number, nullable = false) => ({
  name,
  type: size ? `varchar(${size})` : "longtext",
  nullable,
});
const n = (name: string, nullable = false, defaultValue?: number) => ({
  name,
  type: "bigint",
  nullable,
  ...(defaultValue === undefined ? {} : { defaultValue }),
});
const pk = (...columns: string[]) => ({ name: "PRIMARY", unique: true, columns });
/** Version one preserves separate application and personal ledgers in one relational module. */
export const creationMySQLModels: readonly MySQLModel[] = [
  { name: "panda_force_creation_ledgers", columns: [t("namespace", 256)], indexes: [pk("namespace")] },
  {
    name: "panda_force_creation_progress",
    columns: [
      t("namespace", 256),
      t("id", 128),
      t("taskId", 128),
      n("generation"),
      n("createdAt"),
      n("ordinal"),
      t("event"),
    ],
    indexes: [
      pk("namespace", "id"),
      { name: "creation_progress_order", unique: true, columns: ["namespace", "taskId", "generation", "ordinal"] },
      { name: "creation_progress_task", unique: false, columns: ["namespace", "taskId", "createdAt", "id"] },
    ],
  },
  {
    name: "panda_force_creation_tasks",
    columns: [
      t("namespace", 256),
      t("id", 128),
      t("owner", 200),
      t("projectId", 128),
      t("operationId", 128),
      t("spec"),
      t("signature", 64),
      { ...t("state", 16), defaultValue: "queued" },
      n("generation", false, 0),
      n("attempts", false, 0),
      t("token", 128, true),
      n("leaseUntil", true),
      t("sessionId", 128, true),
      t("runId", 128, true),
      n("cancelRequested", false, 0),
      t("outputDigest", 64, true),
      t("artifact", undefined, true),
      t("failure", 64, true),
      n("createdAt"),
      n("updatedAt"),
      n("budget", false, 3),
    ],
    indexes: [
      pk("namespace", "id"),
      { name: "creation_operation", unique: true, columns: ["namespace", "operationId"] },
      { name: "creation_active", unique: false, columns: ["namespace", "state", "leaseUntil"] },
      { name: "creation_owner", unique: false, columns: ["namespace", "owner", "projectId", "createdAt"] },
      { name: "creation_queue", unique: false, columns: ["namespace", "state", "createdAt", "id"] },
    ],
  },
  {
    name: "panda_force_creation_questions",
    columns: [
      t("namespace", 256),
      t("id", 128),
      t("taskId", 128),
      t("owner", 200),
      n("generation"),
      t("questionDigest", 64),
      t("answerDigest", 64, true),
      t("state", 16),
      n("createdAt"),
      n("answeredAt", true),
      t("pendingTaskId", 128, true),
    ],
    indexes: [
      pk("namespace", "id"),
      {
        name: "creation_question_identity",
        unique: true,
        columns: ["namespace", "taskId", "generation", "questionDigest"],
      },
      { name: "creation_one_pending", unique: true, columns: ["namespace", "pendingTaskId"] },
      {
        name: "creation_question_history",
        unique: false,
        columns: ["namespace", "owner", "taskId", "state", "createdAt", "id"],
      },
    ],
  },
  {
    name: "panda_force_creation_actions",
    columns: [t("namespace", 256), t("id", 128), t("owner", 200), t("taskId", 128), t("request", 64), n("createdAt")],
    indexes: [
      pk("namespace", "id"),
      { name: "creation_actions_task", unique: false, columns: ["namespace", "taskId"] },
    ],
  },
];
const creation = mysqlModelModule("creation", creationMySQLModels, {
  readWrite: true,
  importFrom: ["sqlite"],
});
const shippedSteps = creation.migrations.mysql![0]!.steps;
export const mysqlCreationModule = {
  ...creation,
  migrations: {
    mysql: [
      {
        version: 1,
        steps: shippedSteps.filter((step) => step.id !== "panda_force_creation_progress"),
        historicalSteps: [shippedSteps],
      },
      { version: 2, steps: shippedSteps.filter((step) => step.id === "panda_force_creation_progress") },
    ],
  },
};
