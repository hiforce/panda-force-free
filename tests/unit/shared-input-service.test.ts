import { expect, test } from "bun:test";
import {
  prepareSharedInput,
  readSharedRecoveryState,
  submitPreparedInput,
} from "../../src/server/bridge/shared-input.js";

test("an already loaded CLI thread accepts preparation without scanning its journal", async () => {
  const calls: any[] = [];
  const result = await prepareSharedInput(
    {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method !== "thread/loaded/list") throw new Error("Must not resume the loaded thread");
        return params.cursor ? { data: ["cli"], nextCursor: null } : { data: ["other"], nextCursor: "page2" };
      },
      getThreadMetadata: async () => ({ id: "cli", cwd: "/home/code", canAcceptDirectInput: null }),
    },
    { threadId: "cli" },
  );
  expect(calls.map((call) => call.method)).toEqual(["thread/loaded/list", "thread/loaded/list"]);
  expect(result.thread.canAcceptDirectInput).toBe(true);
  expect(result.pandaAlreadyLoaded).toBe(true);
});

test("a stored unloaded thread is resumed with history excluded", async () => {
  const calls: any[] = [];
  const result = await prepareSharedInput(
    {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return method === "thread/loaded/list" ? { data: [], nextCursor: null } : { thread: { id: "stored" } };
      },
      getThreadMetadata: async () => {
        throw new Error("Not loaded");
      },
    },
    { threadId: "stored", excludeTurns: false },
  );
  expect(calls[1]).toEqual({ method: "thread/resume", params: { threadId: "stored", excludeTurns: true } });
  expect(result.thread.id).toBe("stored");
});

test("a disconnected daemon is not treated as an unloaded thread", async () => {
  await expect(
    prepareSharedInput(
      {
        request: async () => {
          throw new Error("Daemon disconnected");
        },
        getThreadMetadata: async () => ({}),
      },
      { threadId: "cli" },
    ),
  ).rejects.toThrow("Daemon disconnected");
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

test("loaded input is submitted once without hydrating history or falsely marking a subscription", async () => {
  for (const method of ["turn/start", "turn/steer"]) {
    const calls: any[] = [];
    const params = { threadId: "loaded", input: [{ type: "text", text: "Answer" }] };
    const result = await submitPreparedInput(
      {
        request: async (operation, input) => {
          calls.push({ operation, input });
          if (operation === "thread/loaded/list") return { data: ["loaded"] };
          if (operation === method) return { accepted: true };
          throw new Error("Unexpected native operation: " + operation);
        },
        getThreadMetadata: async () => ({ id: "loaded", canAcceptDirectInput: false }),
        recordPrepared: (prepared) => expect(prepared.thread.canAcceptDirectInput).toBe(true),
        markSubscribed: () => {
          throw new Error("The loaded-list check is not a subscription");
        },
      },
      method,
      params,
    );
    expect(result).toEqual({ accepted: true });
    expect(calls.map((call) => call.operation)).toEqual(["thread/loaded/list", method]);
    expect(calls[1].input).toEqual(params);
  }
});

test("unloaded input resumes on the same connection before submission and never submits after preparation fails", async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const dispatch = submitPreparedInput(
      {
        request: async (method, params) => {
          calls.push(method);
          if (method === "thread/loaded/list") return { data: [] };
          if (method === "thread/resume") {
            expect(params.excludeTurns).toBe(true);
            if (fail) throw new Error("Synthetic preparation failure");
            return { thread: { id: "stored" } };
          }
          if (method === "turn/start") return { accepted: true };
          throw new Error(method);
        },
        getThreadMetadata: async () => {
          throw new Error("Not loaded");
        },
        recordPrepared: () => calls.push("record"),
        markSubscribed: () => calls.push("subscribed"),
      },
      "turn/start",
      { threadId: "stored", input: [{ type: "text", text: "Answer" }] },
    );
    if (fail) {
      await expect(dispatch).rejects.toThrow("Synthetic preparation failure");
      expect(calls).toEqual(["thread/loaded/list", "thread/resume"]);
    } else {
      await expect(dispatch).resolves.toEqual({ accepted: true });
      expect(calls).toEqual(["thread/loaded/list", "thread/resume", "record", "subscribed", "turn/start"]);
    }
  }
});

test("an input acknowledgement timeout is propagated without replaying an accepted mutation", async () => {
  const calls: string[] = [];
  const failure = new Error("Input acknowledgement timed out");
  await expect(
    submitPreparedInput(
      {
        request: async (method) => {
          calls.push(method);
          if (method === "thread/loaded/list") return { data: ["loaded"] };
          throw failure;
        },
        getThreadMetadata: async () => ({ id: "loaded" }),
        recordPrepared: () => {},
        markSubscribed: () => {},
      },
      "turn/start",
      { threadId: "loaded", input: [{ type: "text", text: "Answer" }] },
    ),
  ).rejects.toBe(failure);
  expect(calls).toEqual(["thread/loaded/list", "turn/start"]);
});
