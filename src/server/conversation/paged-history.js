import { createHash, randomBytes } from "node:crypto";
import { createEvictionLogger } from "../misc/eviction-log.js";
const logEviction = createEvictionLogger("paged-history");
const MAX_NATIVE_PAGE_ITEMS = 20;

export async function readNativeItemPage(
  request,
  { threadId, turnId, cursor, limit = 20, maxDurationMs = 2000, now = () => performance.now() },
) {
  const data = [];
  let nextCursor = cursor;
  const seen = new Set();
  const started = now();
  for (let i = 0; i < Math.min(limit, MAX_NATIVE_PAGE_ITEMS); i++) {
    // Return the items already available instead of multiplying the native RPC
    // deadline across 20 serial reads. The cursor resumes from the same place.
    if (i > 0 && now() - started >= maxDurationMs) break;
    // A user image item can contain tens of MiB of inline data. Normalize each
    // native item before fetching another instead of receiving a huge batch.
    const page = await request("thread/items/list", {
      threadId,
      ...(turnId ? { turnId } : {}),
      limit: 1,
      sortDirection: "desc",
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
    data.push(...page.data);
    nextCursor = page.nextCursor;
    if (!nextCursor || !page.data.length) break;
    if (seen.has(nextCursor)) throw new Error("Native history cursor did not advance");
    seen.add(nextCursor);
  }
  return { data, nextCursor };
}

// Adapt native item pagination to the browser's history contract. No rollout
// scans or full thread/read calls: a long-running CLI journal can exceed 20 GB.
export function createPagedConversationHistory({ request, getThread }) {
  const epoch = randomBytes(8).toString("hex"),
    threads = new Map();
  return {
    async read({ threadId, cursor, revision, oldestItemId, limit = 100 } = {}) {
      if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("History limit must be between 1 and 100");
      let stored = threads.get(threadId);
      if (!stored)
        stored = {
          generation: randomBytes(6).toString("hex"),
          orders: new Map(),
          turnOrders: new Map(),
          maxOrder: -1,
          seen: 0,
          latest: new Map(),
        };
      const revisionPrefix = `${epoch}:${stored.generation}:`;
      let anchor = null;
      if (cursor) {
        try {
          if (typeof cursor !== "string" || cursor.length > 16384) throw new Error();
          anchor = JSON.parse(Buffer.from(cursor, "base64url").toString());
          if (
            anchor.epoch !== epoch ||
            anchor.generation !== stored.generation ||
            anchor.threadId !== threadId ||
            typeof anchor.cursor !== "string" ||
            !Number.isSafeInteger(anchor.before)
          )
            throw new Error();
        } catch {
          throw new Error("History cursor expired; refresh the conversation");
        }
      }
      threads.delete(threadId);
      threads.set(threadId, stored);
      while (threads.size > 8) {
        threads.delete(threads.keys().next().value);
        logEviction("thread page state");
      }
      const [thread, page, summaries] = await Promise.all([
        getThread(threadId),
        readNativeItemPage(request, { threadId, limit, ...(anchor ? { cursor: anchor.cursor } : {}) }),
        request("thread/turns/list", { threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded" }),
      ]);
      const records = [...page.data].reverse(),
        knownIndex = records.findIndex((record) => stored.orders.has(`${record.turnId}:${record.item.id}`));
      let order = anchor
        ? anchor.before - records.length
        : knownIndex >= 0
          ? stored.orders.get(`${records[knownIndex].turnId}:${records[knownIndex].item.id}`) - knownIndex
          : stored.maxOrder + 1;
      const turns = new Map(),
        metadata = new Map(summaries.data.map((turn) => [turn.id, turn])),
        latest = new Map();
      for (const record of records) {
        const key = `${record.turnId}:${record.item.id}`;
        if (stored.orders.has(key)) order = stored.orders.get(key);
        else {
          stored.orders.set(key, order);
          stored.seen++;
        }
        stored.maxOrder = Math.max(stored.maxOrder, order);
        stored.turnOrders.set(record.turnId, Math.min(stored.turnOrders.get(record.turnId) ?? order, order));
        let turn = turns.get(record.turnId);
        if (!turn) {
          const info = metadata.get(record.turnId) || {
            id: record.turnId,
            status: "completed",
            startedAt: record.startedAtMs == null ? null : record.startedAtMs / 1000,
          };
          turn = { ...info, itemsView: "full", historyOrder: stored.turnOrders.get(record.turnId), items: [] };
          turns.set(record.turnId, turn);
        }
        turn.items.push({ ...record.item, historyOrder: order });
        latest.set(key, order);
        order++;
      }
      const refresh = !anchor && typeof revision === "string" && revision.startsWith(revisionPrefix);
      const minOrder = records.length ? stored.orders.get(`${records[0].turnId}:${records[0].item.id}`) : Infinity;
      const removedItemIds = refresh
        ? [...stored.latest].filter(([key, rank]) => rank >= minOrder && !latest.has(key)).map(([key]) => key)
        : [];
      const resultTurns = [...turns.values()].sort((a, b) => a.historyOrder - b.historyOrder);
      const nextRevision =
        revisionPrefix +
        createHash("sha256")
          .update(JSON.stringify([thread, resultTurns]))
          .digest("hex");
      const nextCursor = page.nextCursor
        ? Buffer.from(
            JSON.stringify({
              epoch,
              generation: stored.generation,
              threadId,
              cursor: page.nextCursor,
              before: Number.isFinite(minOrder) ? minOrder : (anchor?.before ?? stored.maxOrder + 1),
            }),
          ).toString("base64url")
        : null;
      if (!anchor) stored.latest = latest;
      while (stored.orders.size > 4000) stored.orders.delete(stored.orders.keys().next().value);
      while (stored.turnOrders.size > 4000) stored.turnOrders.delete(stored.turnOrders.keys().next().value);
      return {
        thread,
        history: {
          nativePages: true,
          mode: anchor ? "page" : refresh ? "delta" : "snapshot",
          revision: nextRevision,
          preserveOlderPages: refresh,
          resetLoadedHistory: !anchor && Boolean(revision) && !refresh,
          removedItemIds,
          turns: refresh && revision === nextRevision ? [] : resultTurns,
          nextCursor,
          oldestItemId:
            refresh && oldestItemId
              ? oldestItemId
              : records.length
                ? `${records[0].turnId}:${records[0].item.id}`
                : null,
          totalItems: Math.max(stored.seen, records.length + (page.nextCursor ? 1 : 0)),
        },
      };
    },
    clear() {
      threads.clear();
    },
  };
}
