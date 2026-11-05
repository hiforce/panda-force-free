import { describe, expect, test } from "bun:test";
import { createSessionRuntime } from "../../src/client/session-runtime.js";

const started = (turnId: string, historyTailId = "previous") => ({
  status: { type: "active" },
  turnId,
  turnStatus: "inProgress",
  historyTailId,
});
const completed = (turnId: string) => ({
  status: { type: "idle" },
  turnId,
  turnStatus: "completed",
  completed: true,
});
describe("session runtime ownership", () => {
  test("ignores a late completion and failure belonging to an older turn", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("new"));
    expect(runtime.update("a", completed("old"))).toBe(false);
    runtime.rememberError("a", { message: "Old failure", turnId: "old" });
    expect(runtime.get("a")?.error).toBeUndefined();
    expect(runtime.activeTurnId({ id: "a" })).toBe("new");
    runtime.update("a", completed("new"));
    expect(runtime.activeTurnId({ id: "a" })).toBe("");
  });
  test("does not let an uncorrelated idle notification stop a newly started turn", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("new", "old"));
    runtime.update("a", { status: { type: "idle" } });
    const thread = { id: "a", status: { type: "idle" }, turns: [{ id: "old", status: "completed" }] };
    expect(runtime.activeTurnId(thread)).toBe("new");
    expect(runtime.latestStatus(thread)).toBe("inProgress");
    runtime.observeTurn("a", { id: "new", status: "completed" }, "new");
    expect(runtime.activeTurnId(thread)).toBe("");
  });
  test("a late retired turn cannot replace the latest completed status", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("old"));
    runtime.update("a", completed("old"));
    runtime.update("a", started("new"));
    runtime.update("a", completed("new"));
    expect(runtime.update("a", completed("old"))).toBe(false);
    expect(runtime.get("a").turn.id).toBe("new");
  });
  test("keeps independent sessions running when the selected session changes", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("turn-a"));
    runtime.update("b", started("turn-b"));
    expect(runtime.activeTurnId({ id: "a" })).toBe("turn-a");
    expect(runtime.activeTurnId(null)).toBe("");
    expect(runtime.activeTurnId({ id: "b" })).toBe("turn-b");
    expect(runtime.activeTurnId({ id: "a" })).toBe("turn-a");
  });
  test("uses newer empty history turns instead of an old runtime completion", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", completed("old"));
    const thread = { id: "a", turns: [{ id: "new", status: "inProgress", items: [] }] };
    expect(runtime.latestStatus(thread)).toBe("inProgress");
    expect(runtime.activeTurnId(thread)).toBe("new");
  });
  test("preserves a new notification while history is still on the previous turn", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("new", "old"));
    const thread = { id: "a", turns: [{ id: "old", status: "completed" }] };
    expect(runtime.latestStatus(thread)).toBe("inProgress");
    expect(runtime.activeTurnId(thread)).toBe("new");
    runtime.observeTurn("a", thread.turns[0], "old");
    expect(runtime.activeTurnId(thread)).toBe("new");
  });
  test("clears deleted session and logout state without touching other sessions", () => {
    const runtime = createSessionRuntime();
    runtime.update("a", started("a1"));
    runtime.update("b", started("b1"));
    runtime.remove("a");
    expect(runtime.get("a")).toBeUndefined();
    expect(runtime.activeTurnId({ id: "b" })).toBe("b1");
    runtime.clear();
    expect(runtime.get("b")).toBeUndefined();
  });
});
