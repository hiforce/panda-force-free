import { expect, test } from "bun:test";
import { createBrowserDispatch } from "../../src/server/bridge/browser-dispatch.js";
import {
  buildApprovalModel,
  normalizeApprovalRequest,
  approvalDecisionResponse,
} from "../../src/shared/codex-surfaces.js";

test("asynchronous request authorization finishes before native dispatch and rejects without native side effects", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const bridge = createBrowserDispatch({
    isAllowedMethod: () => true,
    request: async () => {
      calls.push("native");
      return {};
    },
    pendingServerRequests: new Map(),
    sendRaw: () => {},
    broadcast: () => {},
  });
  bridge.before(async () => {
    await waiting;
    calls.push("authorized");
  });
  const pending = bridge.dispatch({ type: "rpc", id: "one", method: "thread/read", params: {} });
  expect(calls).toEqual([]);
  finish();
  await pending;
  expect(calls).toEqual(["authorized", "native"]);
  bridge.before(async () => {
    throw new Error("Outside root");
  });
  const denied = await bridge.dispatch({ type: "rpc", id: "two", method: "thread/read", params: {} });
  expect(denied.type).toBe("rpc/error");
  expect(calls).toEqual(["authorized", "native", "authorized"]);
});

test("native string approval IDs are forwarded exactly once and cannot match a numeric request", async () => {
  const pending = new Map<any, any>([
      ["approval-string", {}],
      [1, {}],
    ]),
    sent: any[] = [],
    events: any[] = [];
  const dispatch = createBrowserDispatch({
    isAllowedMethod: () => true,
    request: async () => ({}),
    pendingServerRequests: pending,
    sendRaw: (m) => sent.push(m),
    broadcast: (m) => events.push(m),
  });
  await dispatch.dispatch({
    type: "codex/response",
    id: 9,
    requestId: "approval-string",
    result: { decision: "accept" },
  });
  await dispatch.dispatch({
    type: "codex/response",
    id: 10,
    requestId: "approval-string",
    result: { decision: "accept" },
  });
  expect(sent).toEqual([{ id: "approval-string", result: { decision: "accept" } }]);
  expect(pending.has(1)).toBe(true);
  expect(events[0].payload.params.requestId).toBe("approval-string");
});

test("the installed CLI legacy approval schema preserves scope, command and response decisions", () => {
  const request = normalizeApprovalRequest({
    id: "legacy",
    method: "execCommandApproval",
    params: {
      conversationId: "native-thread",
      callId: "call-one",
      command: ["bash", "-lc", "echo hello"],
      cwd: "/workspace",
      reason: "Run tests",
    },
  });
  expect(request.params.threadId).toBe("native-thread");
  expect(request.params.itemId).toBe("call-one");
  expect(request.params.command).toBe('bash -lc "echo hello"');
  const model = buildApprovalModel(request);
  expect(approvalDecisionResponse(request, model.primary.decision, model.kind)).toEqual({ decision: "approved" });
  expect(approvalDecisionResponse(request, model.deny.decision, model.kind)).toEqual({
    decision: { denied: { rejection: "Declined in PandaForce" } },
  });
  expect(approvalDecisionResponse(request, model.scoped.decision, model.kind)).toEqual({
    decision: "approved_for_session",
  });
});
