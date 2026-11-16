import { expect, test } from "bun:test";
import { createPagedConversationHistory, readNativeItemPage } from "../../src/server/conversation/paged-history.js";
import { mergeConversationHistory } from "../../src/client/ui-core.js";

function cachedHistoryFixture() {
  let signature: string | null = "original";
  let text = "Original reply";
  let hold: Promise<void> = Promise.resolve();
  let itemReads = 0;
  const service = createPagedConversationHistory({
    getThread: async (id) => ({ id }),
    fingerprint: () => signature,
    request: async (method) => {
      if (method === "thread/turns/list") return { data: [{ id: "turn", status: "completed", items: [] }] };
      itemReads++;
      const response = {
        data: [{ turnId: "turn", item: { id: "reply", type: "agentMessage", text } }],
        nextCursor: null,
      };
      await hold;
      return response;
    },
  });
  return {
    service,
    reads: () => itemReads,
    change(value: string, mark: string | null) {
      text = value;
      signature = mark;
    },
    hold() {
      hold = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    },
    release: () => {},
  };
}

test("latest native pages coalesce concurrent reads and refresh after the journal changes", async () => {
  const fixture = cachedHistoryFixture();
  fixture.hold();
  const first = fixture.service.read({ threadId: "A", limit: 20 });
  const concurrent = fixture.service.read({ threadId: "A", limit: 100 });
  expect(fixture.reads()).toBe(1);
  fixture.release();
  const [initial, shared] = await Promise.all([first, concurrent]);
  expect(shared).toEqual(initial);
  await fixture.service.read({ threadId: "A", limit: 20 });
  expect(fixture.reads()).toBe(1);
  fixture.change("Updated reply", "updated");
  const updated = await fixture.service.read({ threadId: "A", limit: 20, revision: initial.history.revision });
  expect(updated.history.turns[0].items[0].text).toBe("Updated reply");
  expect(fixture.reads()).toBe(2);
  fixture.change("No journal fingerprint", null);
  await fixture.service.read({ threadId: "A" });
  await fixture.service.read({ threadId: "A" });
  expect(fixture.reads()).toBe(4);
});

test("notifications and reconnects during a read cannot repopulate the latest-page cache", async () => {
  for (const reset of ["invalidate", "clear"] as const) {
    const fixture = cachedHistoryFixture();
    fixture.hold();
    const stale = fixture.service.read({ threadId: "A" });
    if (reset === "invalidate") fixture.service.invalidate("A");
    else fixture.service.clear();
    fixture.change("Reply after notification", "original");
    fixture.release();
    await stale;
    const current = await fixture.service.read({ threadId: "A" });
    expect(current.history.turns[0].items[0].text).toBe("Reply after notification");
    expect(fixture.reads()).toBe(2);
  }
});

test("a journal change during a read cannot leave a stale cached page", async () => {
  const fixture = cachedHistoryFixture();
  fixture.hold();
  const stale = fixture.service.read({ threadId: "A" });
  fixture.change("Reply persisted during read", "changed");
  fixture.release();
  await stale;
  const current = await fixture.service.read({ threadId: "A" });
  expect(current.history.turns[0].items[0].text).toBe("Reply persisted during read");
  expect(fixture.reads()).toBe(2);
});

test("native pages preserve older history and item order during live refreshes", async () => {
  let items = Array.from({ length: 6 }, (_, i) => ({
    turnId: "turn",
    item: { id: `i${i}`, type: "agentMessage", text: `${i}` },
  }));
  const calls: string[] = [];
  const service = createPagedConversationHistory({
    getThread: async (id) => ({ id }),
    request: async (method, params) => {
      calls.push(method);
      if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress", items: [] }] };
      if (method !== "thread/items/list") throw new Error("Full history must not be read");
      const end = params.cursor ? items.findIndex((x) => x.item.id === params.cursor) : items.length;
      const start = Math.max(0, end - params.limit);
      return { data: items.slice(start, end).reverse(), nextCursor: start ? items[start].item.id : null };
    },
  });
  const first = await service.read({ threadId: "A", limit: 2 });
  let local = mergeConversationHistory(null, first);
  const older = await service.read({ threadId: "A", cursor: first.history.nextCursor, limit: 2 });
  local = mergeConversationHistory(local, older, { page: true });
  expect(local.turns[0].items.map((x) => x.id)).toEqual(["i2", "i3", "i4", "i5"]);
  const olderCursor = local.history.nextCursor;
  items.push({ turnId: "turn", item: { id: "i6", type: "agentMessage", text: "latest" } });
  local = mergeConversationHistory(
    local,
    await service.read({
      threadId: "A",
      revision: local.history.revision,
      oldestItemId: local.history.oldestItemId,
      limit: 2,
    }),
  );
  expect(local.turns[0].items.map((x) => x.id)).toEqual(["i2", "i3", "i4", "i5", "i6"]);
  expect(local.history.nextCursor).toBe(olderCursor);
  local = mergeConversationHistory(
    local,
    await service.read({ threadId: "A", cursor: local.history.nextCursor, limit: 2 }),
    { page: true },
  );
  expect(local.turns[0].items.map((x) => x.id)).toEqual(["i0", "i1", "i2", "i3", "i4", "i5", "i6"]);
  // Cached legacy/restarted readers use different item ranks. Start a fresh
  // visible window rather than interleaving their ranks with native pages.
  const migrated = await service.read({ threadId: "A", revision: "legacy-reader", limit: 2 });
  expect(migrated.history.resetLoadedHistory).toBe(true);
  expect(mergeConversationHistory(local, migrated).turns[0].items.map((x) => x.id)).toEqual(["i5", "i6"]);
  service.clear();
  await expect(service.read({ threadId: "A", cursor: olderCursor })).rejects.toThrow("cursor expired");
  await expect(service.read({ threadId: "B", cursor: olderCursor })).rejects.toThrow("cursor expired");
  expect(calls.every((method) => method !== "thread/read")).toBe(true);
});

test("slow item pages return progress promptly and their cursor resumes without skipping", async () => {
  let elapsed = 0;
  const request = async (method, params) => {
    expect(method).toBe("thread/items/list");
    expect(params.limit).toBe(1);
    elapsed += 1200;
    const index = Number(params.cursor || 0);
    return {
      data: [{ turnId: "turn", item: { id: `i${index}`, type: "agentMessage" } }],
      nextCursor: index < 4 ? String(index + 1) : null,
    };
  };
  const first = await readNativeItemPage(request, { threadId: "slow", limit: 20, now: () => elapsed });
  expect(first.data.map((record) => record.item.id)).toEqual(["i0", "i1"]);
  expect(first.nextCursor).toBe("2");
  const second = await readNativeItemPage(request, {
    threadId: "slow",
    cursor: first.nextCursor,
    limit: 20,
    now: () => elapsed,
  });
  expect(second.data.map((record) => record.item.id)).toEqual(["i2", "i3"]);
  const last = await readNativeItemPage(request, {
    threadId: "slow",
    cursor: second.nextCursor,
    limit: 20,
    now: () => elapsed,
  });
  expect(last.data.map((record) => record.item.id)).toEqual(["i4"]);
  expect(last.nextCursor).toBeNull();
});

test("latest metadata-only turns survive snapshots, status-only deltas and later item persistence", async () => {
  let newest = { id: "new", status: "inProgress", items: [] };
  let records = [{ turnId: "old", item: { id: "old-message", type: "agentMessage", text: "Previous reply" } }];
  const service = createPagedConversationHistory({
    getThread: async () => ({ id: "A", status: { type: "active" } }),
    request: async (method, params) => {
      if (method === "thread/turns/list") return { data: [newest, { id: "old", status: "completed", items: [] }] };
      const index = Number(params.cursor) || 0;
      return {
        data: records.slice(index, index + 1),
        nextCursor: index + 1 < records.length ? String(index + 1) : null,
      };
    },
  });
  let response = await service.read({ threadId: "A" }),
    local = mergeConversationHistory(null, response);
  expect(local.turns.at(-1)).toMatchObject({ id: "new", status: "inProgress", items: [] });
  newest = { ...newest, status: "completed" };
  response = await service.read({ threadId: "A", ...local.history });
  local = mergeConversationHistory(local, response);
  expect(response.history.mode).toBe("delta");
  expect(local.turns.at(-1).status).toBe("completed");
  records = [{ turnId: "new", item: { id: "new-message", type: "agentMessage", text: "Current reply" } }, ...records];
  local = mergeConversationHistory(local, await service.read({ threadId: "A", ...local.history }));
  expect(local.turns.filter((turn) => turn.id === "new")).toHaveLength(1);
  expect(local.turns.at(-1).items.map((item) => item.id)).toEqual(["new-message"]);
});
