import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";
import { createStateDomains } from "../../src/client/application/state-domains.js";
import { FIELD_DOMAINS, STATE_CONTRACTS } from "../../src/client/application/state-contracts.js";
import { readonlyData, canonicalData } from "../../src/shared/read-model.js";
import { createRenderBatch } from "../../src/client/application/render-batch.js";
import { createProjectionUpdates } from "../../src/client/application/projection-updates.js";

function store() {
  return createStateDomains({ active: { id: "a", turns: [] }, threads: [], config: {}, goals: new Map() });
}

describe("domain capabilities", () => {
  test("all grants name owned fields and writes require reads", () => {
    for (const contract of Object.values(STATE_CONTRACTS)) {
      for (const key of [...contract.read, ...contract.write]) expect(key in FIELD_DOMAINS).toBe(true);
      for (const key of contract.write) expect(contract.read).toContain(key);
    }
    expect(() => createStateDomains({ unexpected: 1 })).toThrow("Unowned");
    expect(() => store().scope("unregistered")).toThrow("Unknown state consumer");
  });
  test("readers see canonical updates without receiving write capabilities", () => {
    const domains = store(),
      reader = domains.scope("diagnostics"),
      writer = domains.scope("sessionStore");
    const changes: unknown[] = [];
    const unsubscribe = domains.subscribe((change) => changes.push(change));
    expect(() => {
      reader.state.active = null;
    }).toThrow("Read-only");
    expect(() => reader.mutations.set("active", null)).toThrow("denied");
    expect(() => reader.mutations.edit("active", () => {})).toThrow("denied");
    expect(() => reader.mutations.collection("threads")).toThrow("denied");
    expect(() => {
      reader.state.active.id = "b";
    }).toThrow("Read-only");
    expect(() => reader.state.active.turns.push({ id: "injected" })).toThrow("Read-only");
    expect(() => Object.getOwnPropertyDescriptor(reader.state.active, "turns").value.push({ id: "injected" })).toThrow(
      "Read-only",
    );
    writer.mutations.set("active", { id: "b", turns: [] });
    expect(reader.state.active.id).toBe("b");
    expect(changes).toEqual([{ domain: "sessions", field: "active" }]);
    unsubscribe();
    writer.mutations.set("active", null);
    expect(changes).toHaveLength(1);
    expect(domains.scope("bindings").state.active).toBeUndefined();
  });
  test("collection read methods never return writable business records", () => {
    const domains = store(),
      privileged = domains.scope("diagnostics", { testing: true });
    privileged.mutations.collection("goals").set("a", { objective: "Review" });
    const goals = privileged.state.goals;
    expect(goals.set).toBeUndefined();
    expect(goals.delete).toBeUndefined();
    for (const record of [goals.get("a"), [...goals.values()][0], [...goals][0][1]])
      expect(() => {
        record.objective = "changed";
      }).toThrow("Read-only");
    goals.forEach((record) =>
      expect(() => {
        record.objective = "changed";
      }).toThrow("Read-only"),
    );
    expect(goals.get("a").objective).toBe("Review");
  });
  test("committed read models serialize for persistent caches without another state store", () => {
    const original = { id: "a", nested: { text: "retained" } },
      view = readonlyData(original);
    expect(canonicalData(view)).toEqual(original);
    expect(canonicalData(view)).not.toBe(original);
    const next = canonicalData({ ...view, items: [view.nested] });
    expect(next.nested).toEqual(original.nested);
    expect(next.nested).not.toBe(original.nested);
    expect(next.items[0]).toEqual(original.nested);
    expect(structuredClone(next)).toEqual(next);
  });
});

test("nested render batches flush once and reject unbalanced completion", () => {
  const batch = createRenderBatch(),
    received: string[] = [];
  batch.subscribe((id) => received.push(id));
  batch.begin();
  batch.begin();
  batch.end("inner");
  expect(batch.active).toBe(true);
  expect(received).toEqual([]);
  batch.end("outer");
  expect(batch.active).toBe(false);
  expect(received).toEqual(["outer"]);
  expect(() => batch.end("extra")).toThrow("Unbalanced");
});

test("projection updates reject command dispatch and coalesce construction invalidations", () => {
  const updates = createProjectionUpdates();
  expect(() => updates.request("turn/start")).toThrow("Unknown projection");
  updates.request("sidebar");
  updates.request("sidebar");
  let count = 0;
  // Resolve the closed projection vocabulary without adding arbitrary topics.
  const handlers = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "sidebar"
          ? () => {
              count++;
              updates.request("sidebar");
            }
          : () => {},
    },
  );
  updates.attach(handlers);
  expect(count).toBe(1);
  updates.request("sidebar");
  expect(count).toBe(2);
  expect(() => updates.attach(handlers)).toThrow("already attached");
});

test("a slower folder read cannot overwrite the latest selection", async () => {
  const { assembleWorkspace } = await import("../../src/client/application/workspace.js");
  const nativeFetch = globalThis.fetch,
    requests: { resolve: (response: Response) => void }[] = [];
  const dom = new JSDOM("");
  const nodes = new Map<string, any>();
  const $ = (key: string) => {
    if (!nodes.has(key)) nodes.set(key, Object.assign(dom.window.document.createElement("div"), { showModal() {} }));
    return nodes.get(key);
  };
  const state = { projectless: true, config: { defaultCwd: "/first" } };
  globalThis.fetch = (() => new Promise((resolve) => requests.push({ resolve }))) as any;
  try {
    const workspace = assembleWorkspace({ $, state });
    workspace.openFolderPicker();
    state.config.defaultCwd = "/latest";
    workspace.openFolderPicker();
    requests[1].resolve(Response.json({ path: "/latest", parent: "/", folders: [] }));
    await Bun.sleep(0);
    expect($("#folderSelection").textContent).toBe("/latest");
    requests[0].resolve(Response.json({ path: "/first", parent: "/", folders: [] }));
    await Bun.sleep(0);
    expect(workspace.folderBrowse.selected).toBe("/latest");
    expect($("#folderSelection").textContent).toBe("/latest");
  } finally {
    globalThis.fetch = nativeFetch;
    dom.window.close();
  }
});
