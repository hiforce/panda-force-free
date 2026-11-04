import { expect, test } from "bun:test";
import { mkdtempSync, openSync, ftruncateSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadHub } from "../src/server/conversation/thread-hub.ts";

test("large thread/read and metadata requests never read the full native journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bounded-thread-"));
  const path = join(directory, "large.jsonl");
  const fd = openSync(path, "w");
  ftruncateSync(fd, 2 * 1024 * 1024 * 1024); closeSync(fd);
  const calls: any[] = [];
  const hub = createThreadHub({
    sharedMode: true, defaultSessionsRoot: directory, reviewDiffs: { record: () => {} },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/list") return { data: [{ id: "large", path, cwd: directory, canAcceptDirectInput: true }] };
      if (method === "thread/items/list") return { data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: "latest" } }], nextCursor: null };
      if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress", items: [] }] };
      throw new Error(`Unbounded native operation: ${method}`);
    },
  });
  try {
    const result = await hub.readBrowserThread({ threadId: "large", includeTurns: true });
    expect(result.thread.turns[0].items.map(item => item.id)).toEqual(["item"]);
    expect(result.history.nativePages).toBe(true);
    expect(result.thread.history.revision).toBeTruthy();
    const previousCalls = calls.length;
    const metadata = await hub.readBrowserThread({ threadId: "large", includeTurns: false });
    expect(metadata.thread.cwd).toBe(directory);
    expect(metadata.thread.turns).toEqual([]);
    expect(calls).toHaveLength(previousCalls);
    expect(calls.some(call => call.method === "thread/read" || call.method === "thread/resume")).toBe(false);
    expect(calls.find(call => call.method === "thread/turns/list").params.itemsView).toBe("notLoaded");
    expect(calls.find(call => call.method === "thread/items/list").params.limit).toBe(1);
    const turns = await hub.readBrowserTurns({ threadId: "large", limit: 1, itemsView: "full" });
    expect(turns.data[0].items.map(item => item.id)).toEqual(["item"]);
    expect(calls.filter(call => call.method === "thread/turns/list").every(call => call.params.itemsView === "notLoaded")).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
