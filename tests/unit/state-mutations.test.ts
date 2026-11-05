import { expect, test } from "bun:test";
import { createStateDomains } from "../../src/client/application/state-domains.js";
import { canonicalData } from "../../src/shared/read-model.js";

const goal = (objective: string) => ({
  threadId: "session",
  goalId: "goal",
  status: "active",
  objective,
  progress: { completed: 1 },
});

function fixture() {
  const domains = createStateDomains({
    active: { id: "session", turns: [{ id: "turn", status: "completed", items: [] }] },
    goals: new Map([["session", goal("Original")]]),
    activityItems: new Map([["turn", new Map([["item", { id: "item", type: "agentMessage", text: "Original" }]])]]),
  });
  return { domains, ...domains.scope("diagnostics", { testing: true }) };
}

test("failed edits roll back without notifying or exposing partial changes", () => {
  const { domains, state, mutations } = fixture();
  const changes: unknown[] = [];
  domains.subscribe((change: unknown) => changes.push(change));
  expect(() =>
    mutations.edit("active", (draft: { id: string }) => {
      draft.id = "uncommitted";
      throw new Error("Failed recipe");
    }),
  ).toThrow("Failed recipe");
  expect(state.active!.id).toBe("session");
  expect(changes).toEqual([]);
});

test("successful nested collection edits notify once and invalidate their draft", () => {
  const { domains, state, mutations } = fixture();
  const changes: unknown[] = [];
  let escaped: { text?: string } | undefined;
  domains.subscribe((change: unknown) => changes.push(change));
  mutations.edit("activityItems", (draft) => {
    escaped = draft.get("turn")!.get("item")!;
    escaped.text = "Committed";
  });
  expect(state.activityItems.get("turn")!.get("item")!.text).toBe("Committed");
  expect(changes).toEqual([{ domain: "timeline", field: "activityItems" }]);
  expect(() => {
    escaped!.text = "Late write";
  }).toThrow();
});

test("collection updates protect retained inputs and notify their owning field", () => {
  const { domains, state, mutations } = fixture();
  const input = goal("New");
  const changes: unknown[] = [];
  domains.subscribe((change: unknown) => changes.push(change));
  mutations.collection("goals").set("other", input);
  input.progress.completed = 0;
  expect(state.goals.get("other")!.progress?.completed).toBe(1);
  mutations.collection("goals").update("other", (draft) => {
    draft.objective = "Updated";
  });
  expect(state.goals.get("other")!.objective).toBe("Updated");
  expect(changes).toHaveLength(2);
  expect(() => mutations.collection("goals").update("missing", () => {})).toThrow("missing");
  expect(changes).toHaveLength(2);
});

test("materializing a read view cannot recover a writable reference to stored data", () => {
  const { state } = fixture();
  const copy = canonicalData(state.active);
  copy!.id = "Independent";
  expect(state.active!.id).toBe("session");
  // @ts-expect-error Read-only maps deliberately omit native writers.
  expect(state.activityItems.get("turn")!.set).toBeUndefined();
  expect(() => {
    // @ts-expect-error Runtime tests also defend against untyped callers.
    state.activityItems.get("turn")!.get("item")!.text = "Injected";
  }).toThrow();
});

test("an inserted caller record remains independent and writable outside the store", () => {
  const { state, mutations } = fixture();
  const input = goal("Inserted");
  mutations.edit("goals", (draft) => {
    draft.set("new", input);
  });
  input.progress.completed = 0;
  expect(state.goals.get("new")!.progress?.completed).toBe(1);
  expect(Object.isFrozen(input)).toBe(false);
});

test("an edit materializes nested read-only collections before committing", () => {
  const { state, mutations } = fixture();
  mutations.edit("activityItems", (draft) => {
    // @ts-expect-error Untyped callers can insert a read view; adoption still detaches it.
    draft.set("copy", state.activityItems.get("turn"));
  });
  expect(state.activityItems.get("copy")!.get("item")!.text).toBe("Original");
  // @ts-expect-error Read-only maps deliberately omit native writers.
  expect(state.activityItems.get("copy")!.set).toBeUndefined();
});

test("a patch validates every grant before publishing one coherent update", () => {
  const { domains, state, mutations } = fixture();
  const observed: string[] = [];
  domains.subscribe(() => {
    observed.push(state.active!.id + ":" + state.goals.size);
  });
  mutations.patch({ active: { id: "next", turns: [] }, goals: new Map() });
  expect(observed).toEqual(["next:0", "next:0"]);
  const reader = domains.scope("diagnostics");
  // @ts-expect-error Diagnostics cannot write application fields.
  expect(() => reader.mutations.patch({ active: null, goals: new Map() })).toThrow("denied");
  expect(state.active!.id).toBe("next");
});
