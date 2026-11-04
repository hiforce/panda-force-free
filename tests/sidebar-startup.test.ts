import { afterEach, expect, test } from "bun:test";
import { createSidebarCache } from "../src/client/sidebar-cache.js";
import { startStartupReads, takeStartupRead } from "../src/client/startup-reads.js";

afterEach(() => { delete globalThis.__codexWebuiStartupReads; });
const key = "sidebar";
function fixture() {
  const data = new Map();
  const storage = { get: key => data.get(key) || null, set: (key, value) => data.set(key, value), remove: key => data.delete(key) };
  let time = 1_000_000;
  return { data, storage, now: () => time, advance: ms => { time += ms; } };
}

test("sidebar cache restores bounded metadata and hidden projects without chat bodies", () => {
  const f = fixture(), cache = createSidebarCache({ ...f, key });
  cache.saveVisibility({ revision: 17, hiddenProjects: { "/projects/hidden": { hiddenAt: 17 } } });
  cache.saveThreads([{ id: "thread", name: "Latest session", cwd: "/projects/visible", status: { type: "active" },
    updatedAt: 200, turns: [{ items: [{ text: "private chat body", url: "data:image/png;base64,private" }] }], path: "/private/rollout.jsonl" }], "/projects");
  const restored = createSidebarCache({ ...f, key }).read();
  expect(restored.threads).toEqual([{ id: "thread", name: "Latest session", cwd: "/projects/visible", status: { type: "active" }, updatedAt: 200 }]);
  expect(restored.visibility.hiddenProjects).toHaveProperty("/projects/hidden");
  expect(f.data.get(key)).not.toContain("private chat body");
  expect(f.data.get(key)).not.toContain("data:image");
  expect(f.data.get(key)).not.toContain("rollout.jsonl");
  cache.remove("thread");
  expect(createSidebarCache({ ...f, key }).read().threads).toEqual([]);
  cache.clear({ disableWrites: true });
  cache.saveThreads([{ id: "late-reply" }], "/projects");
  cache.saveVisibility({ revision: 18, hiddenProjects: {} });
  expect(createSidebarCache({ ...f, key }).read()).toBeNull();
});

test("expired, corrupt and oversized sidebar snapshots fall back to fresh reads", () => {
  const f = fixture(), cache = createSidebarCache({ ...f, key });
  cache.saveVisibility({ revision: 0, hiddenProjects: {} });
  cache.saveThreads([{ id: "valid", name: "Session" }], "/home");
  f.advance(49 * 60 * 60 * 1000);
  expect(createSidebarCache({ ...f, key }).read()).toBeNull();
  f.data.set(key, "{broken"); expect(createSidebarCache({ ...f, key }).read()).toBeNull();
  f.data.set(key, JSON.stringify({ version: 1, updatedAt: f.now(), home: "/home", visibility: { revision: 0, hiddenProjects: {} }, threads: [null] }));
  expect(createSidebarCache({ ...f, key }).read()).toBeNull();
  const fresh = createSidebarCache({ ...f, key });
  fresh.saveVisibility({ revision: 0, hiddenProjects: {} });
  fresh.saveThreads(Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, cwd: "/" + "x".repeat(2047) })), "/home");
  expect(f.data.has(key)).toBe(false);
});

test("authenticated startup reads run in parallel and are consumed once", async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    return Response.json(path === "/api/config" ? { home: "/home" } : path === "/api/projects/visibility"
      ? { revision: 0, hiddenProjects: {} } : { type: "rpc/result", result: { data: [{ id: "recent" }] } });
  };
  startStartupReads({ fetchImpl });
  expect(calls.map(call => call.path)).toEqual(["/api/config", "/api/projects/visibility", "/api/rpc"]);
  const fallback = () => { throw new Error("Should consume the prefetched response"); };
  expect(await takeStartupRead("config", fallback)).toEqual({ home: "/home" });
  expect(await takeStartupRead("visibility", fallback)).toEqual({ revision: 0, hiddenProjects: {} });
  expect(await takeStartupRead("threads", fallback)).toEqual({ data: [{ id: "recent" }] });
  expect(await takeStartupRead("threads", () => "fresh request")).toBe("fresh request");
  const request = JSON.parse(calls[2].options.body);
  expect(request.method).toBe("thread/list");
  expect(request.params.limit).toBe(50);
});

test("a stalled startup prefetch aborts and falls back without blocking later reads", async () => {
  let aborted = 0;
  startStartupReads({ timeoutMs: 20, fetchImpl: (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); });
  }) });
  expect(await Promise.all(["config", "visibility", "threads"].map(name => takeStartupRead(name, () => `${name}:fallback`))))
    .toEqual(["config:fallback", "visibility:fallback", "threads:fallback"]);
  expect(aborted).toBe(3);
});
