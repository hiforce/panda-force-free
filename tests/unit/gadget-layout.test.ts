import { test, expect } from "bun:test";
import { GadgetRegistry } from "../../src/server/gadget/registry.js";
import { registerSystemGadgets } from "../../src/gadget/system/server.js";
import {
  defaultGadgetLayout,
  validateGadgetLayout,
  settleGadgetLayout,
  collides,
} from "../../src/shared/gadget/layout.js";
import { GadgetWorkspaceService } from "../../src/server/gadget/service.js";
import { GadgetStore } from "../../src/server/gadget/store.js";
import type { SystemGadgetPorts } from "../../src/gadget/system/ports.js";
import type { GadgetModule } from "../../src/server/gadget/registry.js";
const ports: SystemGadgetPorts = {
  authorize: (owner) => owner === "allowed",
  sessions: async () => [],
  attention: async () => [],
  projects: async () => [],
  skills: async () => [],
  bots: async () => ({ counts: {} }),
};
function registry() {
  const registry = new GadgetRegistry();
  registerSystemGadgets(registry, ports);
  return registry;
}
test("the default layout is derived from registered placement metadata and rejects overlaps, duplicate singletons and unknown instances", () => {
  const catalog = registry().catalog(),
    layout = defaultGadgetLayout(catalog);
  expect(layout.items).toHaveLength(4);
  expect(layout.items.some((item) => item.gadget === "system.attention")).toBe(false);
  expect(validateGadgetLayout(layout, catalog)).toMatchObject({ version: 1, revision: 0 });
  const overlap = structuredClone(layout);
  overlap.items[1]!.x = 0;
  overlap.items[1]!.y = 0;
  expect(() => validateGadgetLayout(overlap, catalog)).toThrow("invalidInput");
  const unknown = structuredClone(layout);
  unknown.items[0]!.gadget = "extension.unknown";
  expect(() => validateGadgetLayout(unknown, catalog)).toThrow("missing");
  const move = layout.items[0]!;
  move.w = 12;
  settleGadgetLayout(layout.items, move);
  expect(layout.items.some((a, n) => layout.items.slice(n + 1).some((b) => collides(a, b)))).toBe(false);
  const invalid = structuredClone(layout);
  invalid.items[0]!.config = { unregistered: "field" };
  expect(() => validateGadgetLayout(invalid, catalog)).toThrow("invalidInput");
});
test("layout transactions isolate owners, replay an uncertain save, reject conflicting reuse and preserve prior receipts", async () => {
  const store = new GadgetStore(":memory:"),
    service = new GadgetWorkspaceService(registry(), store);
  try {
    const layout = await service.layout("allowed");
    const request = { operationId: "operation-0001", layout };
    const saved = await service.save("allowed", request, '"0"');
    expect(saved.revision).toBe(1);
    expect(await service.save("allowed", request, '"0"')).toEqual(saved);
    expect((await service.layout("other")).revision).toBe(0);
    await expect(
      service.save("allowed", { ...request, layout: { ...layout, density: "comfortable" } }, '"0"'),
    ).rejects.toThrow("conflict");
    await expect(service.save("allowed", { operationId: "operation-0002", layout }, '"0"')).rejects.toThrow("conflict");
    const empty = { ...saved, items: [], mobileOrder: [] };
    await service.save("allowed", { operationId: "operation-0003", layout: empty }, '"1"');
    expect((await service.layout("allowed")).items).toHaveLength(0);
    expect(await service.save("allowed", request, '"0"')).toEqual(saved);
  } finally {
    store.close();
  }
});
test("registered extension services reauthorize every call and migrate config without resetting the user layout", async () => {
  const r = registry(),
    base = r.catalog()[1]!,
    old = defaultGadgetLayout(r.catalog());
  let calls = 0;
  const extension: GadgetModule = {
    manifest: {
      ...base,
      id: "example.counter",
      source: "extension",
      singleton: false,
      defaultPlacement: undefined,
      configVersion: 2,
      config: { amount: { type: "number", default: 2, min: 0, max: 20 } },
      services: ["read"],
      actions: [],
    },
    services: {
      read: {
        authorize: (c) => c.owner === "allowed",
        handle: (c) => {
          calls++;
          return { amount: c.config.amount };
        },
      },
    },
    migrations: { 1: (config) => ({ amount: Number(config.count) }) },
  };
  r.register(extension);
  const context = { owner: "forbidden", instanceId: "one", signal: new AbortController().signal };
  await expect(r.invoke("services", "example.counter", "read", context, { amount: 2 }, null)).rejects.toThrow(
    "forbidden",
  );
  expect(calls).toBe(0);
  expect(
    await r.invoke("services", "example.counter", "read", { ...context, owner: "allowed" }, { amount: 4 }, null),
  ).toEqual({ amount: 4 });
  const item = {
    ...old.items[1]!,
    id: "custom-one",
    gadget: "example.counter",
    configVersion: 1,
    config: { count: 3 },
    x: 0,
    y: 25,
  };
  old.items.push(item);
  old.mobileOrder.push(item.id);
  const upgraded = r.migrate(old);
  expect(upgraded.items.at(-1)!.config).toEqual({ amount: 3 });
  expect(upgraded.items.at(-1)!.y).toBe(25);
  expect(() => r.register(extension)).toThrow("invalidInput");
});
test("cancellation responds promptly but retains reservations for providers that ignore abort", async () => {
  const r = registry(),
    base = r.catalog()[1]!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0,
    disposed = 0;
  r.register({
    manifest: {
      ...base,
      id: "example.slow",
      defaultPlacement: undefined,
      source: "extension",
      services: ["read"],
      actions: [],
    },
    services: {
      read: {
        authorize: () => true,
        handle: async () => {
          calls++;
          await gate;
          return { ready: true };
        },
      },
    },
    dispose() {
      disposed++;
    },
  });
  const controller = new AbortController(),
    ctx = { owner: "allowed", instanceId: "slow", signal: controller.signal };
  const active = Array.from({ length: 4 }, () => r.invoke("services", "example.slow", "read", ctx, {}, null));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(4);
  controller.abort();
  expect((await Promise.allSettled(active)).every((r) => r.status === "rejected")).toBe(true);
  await expect(
    r.invoke("services", "example.slow", "read", { ...ctx, signal: new AbortController().signal }, {}, null),
  ).rejects.toThrow("unavailable");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    await r.invoke("services", "example.slow", "read", { ...ctx, signal: new AbortController().signal }, {}, null),
  ).toEqual({ ready: true });
  await r.close();
  await r.close();
  expect(disposed).toBe(1);
  await expect(r.invoke("services", "example.slow", "read", ctx, {}, null)).rejects.toThrow("unavailable");
});
