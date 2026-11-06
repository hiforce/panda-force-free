import { describe, expect, test } from "bun:test";
import { sessionUsageView } from "../../src/client/session-workspace/usage.js";
import { createSessionToolRegistry } from "../../src/client/session-workspace/tool-registry.js";
import { createSessionToolStorage } from "../../src/client/session-workspace/tool-storage.js";
import { STORAGE_KEYS } from "../../src/client/storage.js";
import type { SessionTool } from "../../src/client/contracts/session-workspace.js";

describe("session token projection", () => {
  test("missing metrics remain unknown while reported zero is preserved", () => {
    const missing = sessionUsageView();
    expect(missing.total).toBeNull();
    expect(missing.input).toBeNull();
    expect(missing.contextPercent).toBeNull();
    const zero = sessionUsageView({
      total: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      last: { totalTokens: 0 },
      modelContextWindow: 200000,
    });
    expect(zero.total).toBe(0);
    expect(zero.contextPercent).toBe(0);
    expect(zero.inputPercent).toBeNull();
  });
  test("cached input is a subset of input and context uses the latest report", () => {
    const view = sessionUsageView({
      total: { inputTokens: 96000, outputTokens: 28800, cachedInputTokens: 64000 },
      last: { totalTokens: 76200 },
      modelContextWindow: 200000,
    });
    expect(view.total).toBe(124800);
    expect(view.cached).toBe(64000);
    expect(view.contextPercent).toBeCloseTo(38.1);
    expect(view.inputPercent).toBeCloseTo(76.923);
  });
  test("partial counters and invalid windows do not invent zero consumption", () => {
    const view = sessionUsageView({
      total: { totalTokens: 800, inputTokens: 600, cachedInputTokens: -1 },
      last: { totalTokens: 500 },
      modelContextWindow: 0,
    });
    expect(view.total).toBe(800);
    expect(view.output).toBeNull();
    expect(view.cached).toBeNull();
    expect(view.inputPercent).toBeNull();
    expect(view.contextPercent).toBeNull();
    expect(sessionUsageView({ total: { inputTokens: Infinity, outputTokens: -2 } }).total).toBeNull();
  });
  test("a full context meter never changes the reported counter", () => {
    const view = sessionUsageView({ last: { totalTokens: 240000 }, modelContextWindow: 200000 });
    expect(view.contextPercent).toBe(100);
    expect(view.context).toBe(240000);
  });
});

function memory() {
  const values = new Map<string, unknown>();
  return {
    values,
    getJson: (key: string, fallback: unknown) => structuredClone(values.get(key) ?? fallback),
    setJson: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  };
}
function registry(activate = () => {}) {
  const tools: SessionTool[] = ["files", "changes", "terminal", "notes", "checklist"].map((id) => ({
    id,
    title: "common.files",
    description: "sessionview.filesHint",
    icon: "file",
    enabled: id !== "checklist",
    activate,
  }));
  return createSessionToolRegistry(tools);
}
describe("session tool isolation", () => {
  test("pins are bounded, persisted and never execute an action", () => {
    let calls = 0;
    const persistence = memory(),
      tools = registry(() => {
        calls++;
      });
    const store = createSessionToolStorage(tools, "alice", persistence);
    expect(store.pin("notes")).toBe(false);
    expect(store.pin("terminal")).toBe(true);
    expect(store.pin("notes")).toBe(true);
    store.move("notes", -1);
    expect(store.preferences().pinned).toEqual(["files", "notes", "changes"]);
    store.enable("notes", false);
    expect(store.preferences().pinned).toEqual(["files", "changes"]);
    expect(createSessionToolStorage(tools, "alice", persistence).preferences()).toEqual(store.preferences());
    expect(createSessionToolStorage(tools, "bob", persistence).preferences().pinned).toEqual([
      "files",
      "changes",
      "terminal",
    ]);
    expect(calls).toBe(0);
  });
  test("documents persist only for the same user and session and returned data is detached", () => {
    const persistence = memory(),
      tools = registry(),
      alice = createSessionToolStorage(tools, "alice", persistence);
    expect(alice.saveDocument("one", { note: "private note", checks: [{ id: "x", text: "Review", done: true }] })).toBe(
      true,
    );
    expect(alice.document("two").note).toBe("");
    expect(createSessionToolStorage(tools, "bob", persistence).document("one").note).toBe("");
    const restored = createSessionToolStorage(tools, "alice", persistence);
    const document = restored.document("one");
    document.note = "unsaved mutation";
    expect(restored.document("one").note).toBe("private note");
    expect(restored.document("one").checks[0].done).toBe(true);
  });
  test("unknown stored tools cannot register actions and corrupt preferences recover defaults", () => {
    const persistence = memory(),
      tools = registry();
    persistence.values.set(STORAGE_KEYS.sessionToolsFor("alice"), {
      pinned: ["files", "unknown", "files", "notes"],
      disabled: ["malicious"],
    });
    const store = createSessionToolStorage(tools, "alice", persistence);
    expect(store.preferences().pinned).toEqual(["files", "notes"]);
    expect(store.pin("unknown")).toBe(false);
    persistence.values.set(STORAGE_KEYS.sessionToolsFor("alice"), {});
    expect(createSessionToolStorage(tools, "alice", persistence).preferences().pinned).toEqual([
      "files",
      "changes",
      "terminal",
    ]);
    expect(() => createSessionToolRegistry([...tools.all(), tools.all()[0]])).toThrow();
    expect(() => createSessionToolRegistry([{ ...tools.all()[0], id: "<script>" }])).toThrow();
  });
  test("unavailable persistence and missing identity remain browser-tab scoped", () => {
    const blocked = { getJson: (_key: string, fallback: unknown) => fallback, setJson: () => {} };
    const local = createSessionToolStorage(registry(), "alice", blocked);
    expect(local.saveDocument("one", { note: "not lost", checks: [] })).toBe(false);
    expect(local.document("one").note).toBe("not lost");
    const persistence = memory();
    const anonymous = createSessionToolStorage(registry(), undefined, persistence);
    expect(anonymous.saveDocument("one", { note: "tab only", checks: [] })).toBe(false);
    expect(persistence.values.size).toBe(0);
  });
});
