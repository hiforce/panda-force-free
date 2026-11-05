import { describe, expect, test } from "bun:test";
import { steerOrStart } from "../../src/client/application/turn-input.js";
import { deliveryIsUncertain } from "../../src/client/application/input-errors.js";
import { createBridgeError, NO_ACTIVE_TURN, THREAD_NOT_FOUND } from "../../src/shared/bridge-errors.js";
function fixture(replies) {
  const calls = [],
    dispatches = [];
  let resumes = 0,
    fallback = 0;
  const args = {
    thread: { id: "session-a", canAcceptDirectInput: true },
    turnId: "turn-a",
    input: [{ type: "text", text: "Answer" }],
    clientUserMessageId: "client-a",
    startOptions: { model: "fixture", cwd: "/workspace" },
    rpc: async (method, params) => {
      calls.push({ method, params });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply || {};
    },
    resume: async () => {
      resumes++;
    },
    onDispatch: (value) => dispatches.push(value),
    onNoActiveTurn: () => {
      fallback++;
    },
  };
  return {
    args,
    calls,
    dispatches,
    get resumes() {
      return resumes;
    },
    get fallback() {
      return fallback;
    },
  };
}
describe("native turn delivery boundary", () => {
  test("a lost acknowledgement is propagated without replay or a new turn", async () => {
    const error = new Error("Codex bridge request timed out"),
      f = fixture([error]);
    await expect(steerOrStart(f.args)).rejects.toBe(error);
    expect(f.calls.map((c) => c.method)).toEqual(["turn/steer"]);
    expect(f.fallback).toBe(0);
    expect(deliveryIsUncertain(error, true)).toBe(true);
    expect(deliveryIsUncertain(error, false)).toBe(false);
  });
  test("a missing native session permits one metadata resume and one retry", async () => {
    const f = fixture([createBridgeError("Missing", THREAD_NOT_FOUND), {}]);
    await steerOrStart(f.args);
    expect(f.resumes).toBe(1);
    expect(f.calls.map((c) => c.method)).toEqual(["turn/steer", "turn/steer"]);
    expect(f.dispatches).toEqual([true, false, true]);
  });
  test("an already prepared session cannot enter a retry loop", async () => {
    const error = createBridgeError("Missing", THREAD_NOT_FOUND),
      f = fixture([error]);
    f.args.thread.canAcceptDirectInput = false;
    await expect(steerOrStart(f.args)).rejects.toBe(error);
    expect(f.resumes).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].params.pandaPrepareInput).toBe(true);
  });
  test("input preparation shares the steer request instead of another browser round trip", async () => {
    const f = fixture([{}]);
    f.args.thread.canAcceptDirectInput = false;
    await steerOrStart(f.args);
    expect(f.resumes).toBe(0);
    expect(f.calls.map((call) => call.method)).toEqual(["turn/steer"]);
    expect(f.calls[0].params.pandaPrepareInput).toBe(true);
  });
  test("only no-active-turn rejection falls back, preserving destination and attachment identity", async () => {
    const f = fixture([createBridgeError("Completed", NO_ACTIVE_TURN), { turn: { id: "new-turn" } }]);
    await steerOrStart(f.args);
    expect(f.fallback).toBe(1);
    expect(f.calls.map((c) => c.method)).toEqual(["turn/steer", "turn/start"]);
    expect(f.calls[1].params).toEqual({
      threadId: "session-a",
      input: f.args.input,
      clientUserMessageId: "client-a",
      model: "fixture",
      cwd: "/workspace",
    });
  });
});

test("suggestions and dispatch share one unique catalog with exact slash matching", async () => {
  const { slashCommandCatalog, parseSlashCommand } = await import("../../src/client/application/command-catalog.js");
  expect(new Set(slashCommandCatalog.map((c) => c.id)).size).toBe(slashCommandCatalog.length);
  for (const command of slashCommandCatalog.filter((c) => c.kind !== "goal")) {
    expect(parseSlashCommand(" /" + command.id.toUpperCase() + " ", command.kind)).toBe(command.id);
    expect(parseSlashCommand(command.id, command.kind)).toBeNull();
    expect(parseSlashCommand("/" + command.id + " arbitrary arguments", command.kind)).toBeNull();
  }
  expect(parseSlashCommand("/unknown", "native")).toBeNull();
});
