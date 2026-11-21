import { expect, test } from "bun:test";
import {
  mysqlCreationMessageRow,
  mysqlCreationQuestionRow,
  mysqlCreationRoundRow,
} from "../../src/server/creation/storage/mysql-rows.js";

test("SQL message and question decoding retains nullable fences and drops storage-only fields", () => {
  const common = { id: "id", owner: "owner", taskId: "task", generation: "7", createdAt: 10n, namespace: "private" };
  const message = mysqlCreationMessageRow({
    ...common,
    requestDigest: "request",
    payloadDigest: "payload",
    state: "received",
    dispatchGeneration: null,
    updatedAt: "11",
  });
  expect(message).toEqual({
    id: "id",
    owner: "owner",
    taskId: "task",
    generation: 7,
    createdAt: 10,
    requestDigest: "request",
    payloadDigest: "payload",
    state: "received",
    dispatchGeneration: null,
    updatedAt: 11,
  });
  const question = mysqlCreationQuestionRow({
    ...common,
    questionDigest: "question",
    answerDigest: null,
    state: "pending",
    answeredAt: null,
    pendingTaskId: "task",
  });
  expect(question.answerDigest).toBeNull();
  expect(question.answeredAt).toBeNull();
  expect(question).not.toHaveProperty("pendingTaskId");
  expect(() => mysqlCreationMessageRow({ ...message, state: "unrecognized" })).toThrow("unavailable");
  expect(() => mysqlCreationMessageRow({ ...message, generation: "9007199254740993" })).toThrow(
    "invalidStoredDatabaseInteger",
  );
});

test("round cursor projections decode aggregate integers without requiring a full task body", () => {
  expect(
    mysqlCreationRoundRow({
      id: "round",
      createdAt: "100",
      creationRootId: "root",
      creationCreatedAt: 1n,
      creationRounds: "12",
      latestTaskId: "latest",
    }),
  ).toEqual({
    id: "round",
    createdAt: 100,
    creationRootId: "root",
    creationCreatedAt: 1,
    creationRounds: 12,
    latestTaskId: "latest",
  });
});
