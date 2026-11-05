import { describe, expect, test } from "bun:test";
import { createSessionState } from "../src/client/application/session-state.js";
import { createLatestRequestGate } from "../src/client/ui-core.js";
describe("session collection ownership", () => {
  test("summary updates preserve loaded history and selecting another view preserves background sessions", () => {
    const history = { id: "a", turns: [{ id: "running", status: "inProgress", items: [] }] },
      state = { active: history, threads: [{ id: "a", name: "Before" }] };
    const sessions = createSessionState(state);
    sessions.upsertSummary({ id: "a", name: "After" });
    sessions.addSummary({ id: "a", name: "Duplicate" });
    expect(state.threads).toEqual([{ id: "a", name: "After" }]);
    expect(state.active).toBe(history);
    sessions.replaceActive(null);
    expect(state.threads).toHaveLength(1);
    sessions.removeSummary("a");
    expect(state.threads).toEqual([]);
  });
  test("one navigation generation invalidates both the history and submission snapshot", () => {
    const gate = createLatestRequestGate(),
      history = gate.next(),
      submission = gate.current;
    gate.next();
    expect(gate.isCurrent(history)).toBe(false);
    expect(gate.current === submission).toBe(false);
  });
});

test("a failed project association retains the committed native session and its input owner", async () => {
  const { assembleInputSessions } = await import("../src/client/application/input-sessions.js");
  const state = { active: null, threads: [], projectless: false },
    sessions = createSessionState(state),
    pending = { owner: "new:0" };
  const failure = new Error("Association failed");
  let created = null,
    starts = 0;
  const service = assembleInputSessions({
    state,
    sessions,
    navigationPort: { threadNavigationGeneration: 1, rememberActiveThread: () => {} },
    selection: { current: 1 },
    viewUpdates: { request() {} },
    transportPort: {
      rpc: async () => {
        starts++;
        return { thread: { id: "committed", canAcceptDirectInput: true } };
      },
    },
    workspacePort: { prepareBusinessSession: async () => {}, renderHeader: () => {} },
    projectsPort: {
      businessProjects: {
        pendingAssignments: new Map(),
        finishAssignment: async () => {
          throw failure;
        },
      },
    },
    deliveryPort: { lockIfFree: () => {} },
    modelsPort: { renderContextUsage: () => {} },
    approvalsPort: { restorePendingApprovals: () => {} },
    sidebarPort: { renderThreads: () => {} },
  });
  await expect(
    service.prepareInputSession({
      thread: null,
      cwd: "/workspace",
      model: "fixture",
      policy: {},
      projectId: "p",
      generation: 1,
      pending,
      token: Symbol(),
      onCreated: (t) => {
        created = t;
      },
    }),
  ).rejects.toBe(failure);
  expect(starts).toBe(1);
  expect(created?.id).toBe("committed");
  expect(state.active?.id).toBe("committed");
  expect(pending.owner).toBe("committed");
});
