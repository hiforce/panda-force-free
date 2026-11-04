import { expect, test } from "bun:test";
import { prepareSharedInput, readSharedRecoveryState } from "../src/server/bridge/shared-input.js";

test("an already loaded CLI thread accepts preparation without scanning its journal", async () => {
  const calls: any[] = [];
  const result = await prepareSharedInput({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method !== "thread/loaded/list") throw new Error("Must not resume the loaded thread");
      return params.cursor ? { data: ["cli"], nextCursor: null } : { data: ["other"], nextCursor: "page2" };
    },
    getThreadMetadata: async () => ({ id: "cli", cwd: "/home/code", canAcceptDirectInput: null }),
  }, { threadId: "cli" });
  expect(calls.map(call => call.method)).toEqual(["thread/loaded/list", "thread/loaded/list"]);
  expect(result.thread.canAcceptDirectInput).toBe(true);
  expect(result.webuiAlreadyLoaded).toBe(true);
});

test("a stored unloaded thread is resumed with history excluded", async () => {
  const calls: any[] = [];
  const result = await prepareSharedInput({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return method === "thread/loaded/list" ? { data: [], nextCursor: null } : { thread: { id: "stored" } };
    },
    getThreadMetadata: async () => { throw new Error("Not loaded"); },
  }, { threadId: "stored", excludeTurns: false });
  expect(calls[1]).toEqual({ method: "thread/resume", params: { threadId: "stored", excludeTurns: true } });
  expect(result.thread.id).toBe("stored");
});

test("a disconnected daemon is not treated as an unloaded thread", async () => {
  await expect(prepareSharedInput({ request: async () => { throw new Error("Daemon disconnected"); }, getThreadMetadata: async () => ({}) }, { threadId: "cli" })).rejects.toThrow("Daemon disconnected");
});

test("shared recovery reads one summary turn and preserves status and error", async () => {
  const turn = { id: "latest", status: "failed", error: { message: "Model at capacity" } };
  const result = await readSharedRecoveryState(async (method, params) => {
    expect(method).toBe("thread/turns/list");
    expect(params).toEqual({ threadId: "cli", limit: 1, sortDirection: "desc", itemsView: "summary" });
    return { data: [turn] };
  }, "cli");
  expect(result.thread.turns).toEqual([turn]);
  await expect(readSharedRecoveryState(async () => ({}), "cli")).rejects.toThrow("state unavailable");
});
