import { expect, test } from "bun:test";
import { createBrowserDispatch } from "../../src/server/bridge/browser-dispatch.ts";
import { splitBrowserRpcParams } from "../../src/shared/browser-rpc-compat.js";
import { submitPreparedInput } from "../../src/server/bridge/shared-input.js";
test("both generations of browser hints are consumed locally; canonical false overrides an old true", () => {
  const x = splitBrowserRpcParams({
    threadId: "active",
    webuiPrepareInput: true,
    pandaPrepareInput: false,
    webuiProjectless: true,
  });
  expect(x.params).toEqual({ threadId: "active" });
  expect(x.flags).toEqual({ pandaPrepareInput: false, pandaProjectless: true });
});
test("an old open tab takes the shared prepare path without leaking hints to the native engine", async () => {
  const requests: any[] = [];
  const bridge = createBrowserDispatch({
    isAllowedMethod: () => true,
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "thread/loaded/list" ? { data: ["active"] } : { ok: true };
    },
    pendingServerRequests: new Map(),
    sendRaw: () => {},
    broadcast: () => {},
  });
  bridge.resolve("thread/resume", ({ params, flags }) =>
    flags.pandaPrepareInput === true ? { thread: { id: params.threadId, canAcceptDirectInput: true } } : undefined,
  );
  const response = await bridge.dispatch({
    type: "rpc",
    id: 1,
    method: "thread/resume",
    params: { threadId: "active", excludeTurns: true, webuiPrepareInput: true },
  });
  expect(response.result.thread.canAcceptDirectInput).toBe(true);
  expect(requests).toEqual([]);
  await bridge.dispatch({
    type: "rpc",
    id: 2,
    method: "thread/start",
    params: { cwd: "/tmp", webuiProjectless: true, pandaProjectless: false },
  });
  expect(requests[0].params).toEqual({ cwd: "/tmp" });
  bridge.resolve("turn/start", ({ params, flags }) =>
    flags.pandaPrepareInput === true
      ? submitPreparedInput(
          {
            request: async (method, params) => {
              requests.push({ method, params });
              return method === "thread/loaded/list" ? { data: ["active"] } : { ok: true };
            },
            getThreadMetadata: async () => ({ id: "active" }),
            recordPrepared: () => {},
            markSubscribed: () => {
              throw new Error("An already-loaded check must not claim a subscription");
            },
          },
          "turn/start",
          params,
        )
      : undefined,
  );
  await bridge.dispatch({
    type: "rpc",
    id: 3,
    method: "turn/start",
    params: { threadId: "active", pandaPrepareInput: true, input: [{ type: "text", text: "Answer" }] },
  });
  expect(requests.slice(1).map((call) => call.method)).toEqual(["thread/loaded/list", "turn/start"]);
  expect(requests.at(-1).params).toEqual({ threadId: "active", input: [{ type: "text", text: "Answer" }] });
});
