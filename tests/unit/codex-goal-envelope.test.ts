import { expect, test } from "bun:test";
import { nativeEnvelope } from "../../src/server/protocol/native.js";

test("native goal changes outside a turn remain deliverable without mutating provider data", () => {
  const value = {
    method: "thread/goal/updated",
    params: {
      threadId: "thread-a",
      turnId: null,
      goal: { threadId: "thread-a", objective: "Keep the full scope", status: "paused", tokensUsed: 312 },
    },
    emittedAtMs: 1794200308307,
  };
  const decoded = nativeEnvelope(value);
  expect(decoded.params).not.toHaveProperty("turnId");
  expect(decoded.params?.goal).toEqual(value.params.goal);
  expect(decoded).toHaveProperty("emittedAtMs", value.emittedAtMs);
  expect(value.params.turnId).toBeNull();
  expect(nativeEnvelope({ ...value, params: { ...value.params, turnId: "turn-a" } }).params?.turnId).toBe("turn-a");
});

test("native nullable goal context does not weaken other portable identity validation", () => {
  expect(() => nativeEnvelope({ method: "thread/goal/updated", params: { threadId: null, turnId: null } })).toThrow(
    "Invalid engine notification identity",
  );
  expect(() => nativeEnvelope({ method: "thread/goal/updated", params: { threadId: "thread-a", turnId: 42 } })).toThrow(
    "Invalid engine notification identity",
  );
  expect(() => nativeEnvelope({ method: "turn/started", params: { threadId: "thread-a", turnId: null } })).toThrow(
    "Invalid engine notification identity",
  );
});
