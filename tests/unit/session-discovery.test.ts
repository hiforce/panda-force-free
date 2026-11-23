import { expect, test } from "bun:test";
import { createSessionDiscovery, directoryKey } from "../../src/server/conversation/discovery.js";
import { createSessionDirectoryIndex } from "../../src/client/session-directory-index.js";

import { sessionFolderTree } from "../../src/client/sidebar-session-folders.js";
import { createSessionListHistory } from "../../src/client/session-list-history.js";
test("directory browsing keeps full paths distinct and combines directory and text filters", async () => {
  const rows = [
    { id: "one", name: "Invoices", cwd: "/alpha/shop/" },
    { id: "two", name: "Invoices", cwd: "/beta/shop" },
    { id: "three", name: "Images", cwd: "/alpha/shop/sub" },
    { id: "four", name: "Invoices older", cwd: "/alpha/shop" },
  ];
  const service = createSessionDiscovery({
    request: async (_method, params) => {
      const offset = Number(params?.cursor || 0);
      return { data: rows.slice(offset, offset + 2), nextCursor: offset + 2 < rows.length ? String(offset + 2) : null };
    },
  });
  const result = await service.history({ directory: "/alpha/shop/", search: "invoice" });
  expect(result.sessions.map((entry) => entry.id)).toEqual(["one", "four"]);
  expect(result.nextCursor).toBeNull();
  expect(directoryKey("C:\\work\\shop\\")).toBe("C:/work/shop");
  expect(directoryKey("/")).toBe("/");
});

test("sparse history reads are bounded and expose the next cursor instead of hiding older results", async () => {
  let calls = 0;
  const service = createSessionDiscovery({
    request: async () => ({ data: [{ id: "s" + ++calls, cwd: "/other" }], nextCursor: String(calls) }),
  });
  const result = await service.history({ directory: "/wanted" });
  expect(calls).toBe(10);
  expect(result.sessions).toEqual([]);
  expect(result.nextCursor).toBe("10");
});

test("directory readers coalesce paged requests and retry failures without caching partial data", async () => {
  let calls = 0,
    fail = true;
  const index = createSessionDirectoryIndex({
    directories: async (cursor) => {
      calls++;
      if (cursor && fail) throw new Error("temporary");
      return { directories: [{ path: "/work", count: 2 }], nextCursor: cursor ? null : "next" };
    },
  });
  await expect(index.read()).rejects.toThrow("temporary");
  fail = false;
  const [a, b] = await Promise.all([index.read(), index.read()]);
  expect(a).toBe(b);
  expect(a).toEqual([{ path: "/work", count: 4, unassignedCount: 4 }]);
  expect(calls).toBe(4);
  await index.read();
  expect(calls).toBe(4);
});

test("invalidating a directory read cannot publish its stale response", async () => {
  let resolveFirst!: (value: { directories: Array<{ path: string; count: number }>; nextCursor: null }) => void;
  let calls = 0;
  const index = createSessionDirectoryIndex({
    directories: () =>
      ++calls === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({ directories: [{ path: "/fresh", count: 1 }], nextCursor: null }),
  });
  const old = index.read();
  index.invalidate();
  const fresh = await index.read();
  resolveFirst({ directories: [{ path: "/stale", count: 1 }], nextCursor: null });
  expect((await old)[0].path).toBe("/fresh");
  expect(await index.read()).toBe(fresh);
});

test("directory counts use actual assigned session IDs and cannot hide an unassigned session", async () => {
  const service = createSessionDiscovery({
    request: async () => ({
      data: [
        { id: "linked", cwd: "/work" },
        { id: "unassigned", cwd: "/work" },
      ],
      nextCursor: null,
    }),
  });
  const result = await service.directories(null, new Set(["linked", "deleted-old-session"]));
  expect(result.directories).toEqual([{ path: "/work", count: 2, unassignedCount: 1 }]);
});

test("the directory tree keeps direct conversations and nested counts under the most specific allowed root", () => {
  const tree = sessionFolderTree(
    [
      { path: "/home/team", count: 1 },
      { path: "/home/team/client/design", count: 2, unassignedCount: 1 },
      { path: "/home/code/example", count: 4 },
      { path: "/home2/elsewhere", count: 7 },
      { path: "/root/notes", count: 3 },
    ],
    ["/home/team", "/root", "/home"],
  );
  expect([...tree.keys()]).toEqual(["/home/team", "/root", "/home"]);
  expect(tree.get("/home/team")).toMatchObject({ direct: 1, total: 2 });
  expect(tree.get("/home/team")?.children.get("/home/team/client")?.direct).toBe(0);
  expect(tree.get("/home")?.total).toBe(4);
  expect(tree.get("/home")?.children.has("/home/team")).toBe(false);
});

test("session listing coalesces cursor reads and preserves native order at page boundaries", async () => {
  const coldManaged = { id: "harness:00000000-0000-0000-0000-000000000001", updatedAt: 1 };
  const calls: string[] = [];
  const history = createSessionListHistory(async (cursor) => {
    calls.push(cursor);
    return cursor
      ? {
          sessions: [
            { id: "a", updatedAt: 4 },
            { id: "x", updatedAt: 3 },
          ],
          nextCursor: null,
        }
      : {
          sessions: [coldManaged, { id: "z", updatedAt: 4 }, { id: "q", updatedAt: 4 }],
          nextCursor: "older",
        };
  });
  await Promise.all([history.more(), history.more()]);
  expect(history.rows([], () => false).map((entry) => entry.id)).toEqual(["z", "q"]);
  expect(calls).toEqual([""]);
  await history.more();
  expect(history.rows([], (id) => id === "q").map((entry) => entry.id)).toEqual(["z", "a", "x", coldManaged.id]);
});
