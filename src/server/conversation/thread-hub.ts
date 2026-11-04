import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { LiveSessionStore } from "../bridge/live-session.js";
import { createConversationHistory } from "./history.js";
import { createPagedConversationHistory, readNativeItemPage } from "./paged-history.js";
import { resolveSafeRegularFile } from "../auth/security.js";
import { unifiedDiffFromFileChanges } from "../../shared/codex-surfaces.js";

const LARGE_JOURNAL_BYTES = 8 * 1024 * 1024;
const LARGE_ROLLOUT_BYTES = 2 * 1024 * 1024;
const THREAD_METADATA_LIMIT = 1000;
const METADATA_SCAN_PAGES = 10;

/**
 * Owns the per-thread server-side state: rollout paths, thread metadata,
 * shared-mode subscriptions, the conversation history caches and live
 * session reads. Everything that records or serves thread data goes
 * through here.
 */
export function createThreadHub({
  request,
  reviewDiffs,
  sharedMode,
  defaultSessionsRoot,
}: {
  request: (method: string, params?: any) => Promise<any>;
  reviewDiffs: { record: (entry: any) => void };
  sharedMode: boolean;
  defaultSessionsRoot: string;
}) {
  const threadPaths = new Map<string, string>();
  const threadMetadata = new Map<string, any>();
  const sharedThreadSubscriptions = new Map<string, Promise<void>>();
  let sessionsRoot = defaultSessionsRoot;
  const liveSessions = new LiveSessionStore();

  function recordFileChangeDiff({ threadId, turnId, changes }: any) {
    const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);
    if (diff) reviewDiffs.record({ threadId, turnId, diff });
  }

  function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
    if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
    const threadId = result?.thread?.id || params?.threadId;
    const turns = result?.thread?.turns || result?.data || [];
    if (typeof threadId !== "string" || !Array.isArray(turns)) return;
    for (const turn of turns) {
      const changes = (turn?.items || []).flatMap((item: any) =>
        item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : [],
      );
      const diff = unifiedDiffFromFileChanges(changes);
      if (typeof turn?.id === "string" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });
    }
  }

  function recordThreadPathsFromRpc(result: any) {
    const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
    for (const thread of threads) {
      if (typeof thread?.id === "string" && ("cwd" in thread || "path" in thread)) {
        if (typeof thread?.path === "string") threadPaths.set(thread.id, thread.path);
        const { turns: omitted, history: omittedHistory, ...metadata } = thread;
        threadMetadata.set(thread.id, metadata);
        while (threadMetadata.size > THREAD_METADATA_LIMIT) threadMetadata.delete(threadMetadata.keys().next().value!);
      }
    }
  }

  async function getThreadMetadata(threadId: string) {
    if (threadMetadata.has(threadId)) return threadMetadata.get(threadId);
    let cursor: string | null = null;
    for (let page = 0; page < METADATA_SCAN_PAGES; page++) {
      const result = await request("thread/list", {
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      recordThreadPathsFromRpc(result);
      if (threadMetadata.has(threadId)) return threadMetadata.get(threadId);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw new Error("Thread not found; refresh the session list");
  }

  const conversationHistory = createConversationHistory({
    readThread: async (threadId: string) => {
      const result = await request("thread/read", { threadId, includeTurns: true });
      recordThreadPathsFromRpc(result);
      recordReviewDiffsFromRpc("thread/read", { threadId }, result);
      const thread = result.thread;
      try {
        const live = await readLiveThread(threadId);
        if (live?.active && live.turn) {
          const index = thread.turns.findIndex((turn: any) => turn.id === live.turn.id);
          const stored = index >= 0 ? thread.turns[index] : null;
          const opening = stored?.items?.find((item: any) => item.type === "userMessage");
          const turn = {
            ...stored,
            ...live.turn,
            items: [
              ...(opening && !live.turn.items.some((item: any) => item.id === opening.id) ? [opening] : []),
              ...live.turn.items,
            ],
          };
          if (index < 0) thread.turns.push(turn);
          else thread.turns[index] = turn;
        }
      } catch {}
      return thread;
    },
    fingerprint: (threadId: string) => {
      try {
        const path = threadPaths.get(threadId);
        if (!path) return null;
        const stat = statSync(path);
        return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch {
        return null;
      }
    },
  });
  const pagedConversationHistory = createPagedConversationHistory({ request, getThread: getThreadMetadata });

  async function readNativeConversationHistory(params: any) {
    if (typeof params?.threadId !== "string" || !params.threadId) throw new Error("Invalid thread id");
    if (sharedMode) {
      const thread = await getThreadMetadata(params.threadId);
      // Native thread/read scans the full journal even when turns are excluded.
      // Item pagination reads the state DB without scanning multi-GB CLI logs.
      try {
        if (!thread.path || statSync(thread.path).size > LARGE_JOURNAL_BYTES)
          return pagedConversationHistory.read(params);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        return pagedConversationHistory.read(params);
      }
    }
    return conversationHistory.read(params);
  }

  async function readConversationHistory(params: any) {
    const result = await readNativeConversationHistory(params);
    try {
      // Native item pagination omits host questionnaire calls, including completed turns.
      const live = await readLiveThread(params.threadId);
      return { ...result, history: { ...result.history, questionTurns: live.questionTurns || [] } };
    } catch {
      return result;
    }
  }

  async function readBrowserThread(params: any) {
    if (typeof params?.threadId !== "string" || !params.threadId) throw new Error("Invalid thread id");
    if (!params.includeTurns) return { thread: { ...(await getThreadMetadata(params.threadId)), turns: [] } };
    // Legacy clients and resync requests must use the same bounded reader as
    // normal history loads. A raw thread/read can exceed the WS message limit
    // and disconnect every request sharing the daemon connection.
    const result = await readConversationHistory({ threadId: params.threadId, limit: 20 });
    const { turns, ...history } = result.history;
    return {
      thread: {
        ...result.thread,
        turns,
        history: {
          revision: history.revision,
          nextCursor: history.nextCursor,
          oldestItemId: history.oldestItemId,
          totalItems: history.totalItems,
        },
      },
      history,
    };
  }

  async function readBrowserTurns(params: any) {
    if (typeof params?.threadId !== "string" || !params.threadId) throw new Error("Invalid thread id");
    const result = await request("thread/turns/list", {
      ...params,
      limit: Math.min(params.limit || 1, 20),
      itemsView: "notLoaded",
    });
    const data = await Promise.all(
      result.data.map(async (turn: any) => {
        const page = await readNativeItemPage(request, { threadId: params.threadId, turnId: turn.id, limit: 20 });
        return { ...turn, itemsView: "summary", items: [...page.data].reverse().map((record) => record.item) };
      }),
    );
    return { ...result, data };
  }

  async function subscribeSharedThread(thread: any) {
    if (!sharedMode || thread?.canAcceptDirectInput !== true) return;
    let subscription = sharedThreadSubscriptions.get(thread.id);
    if (!subscription) {
      // Reading history alone does not subscribe this connection to SSH's events
      // or approvals. Resume the already-loaded thread without replacing policy.
      subscription = request("thread/resume", { threadId: thread.id, excludeTurns: true }).then(() => {});
      sharedThreadSubscriptions.set(thread.id, subscription);
      subscription.catch(() => {
        if (sharedThreadSubscriptions.get(thread.id) === subscription) sharedThreadSubscriptions.delete(thread.id);
      });
    }
    await subscription;
  }

  async function readLiveThread(threadId: unknown) {
    if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
    let path = threadPaths.get(threadId);
    if (!path) {
      const result = sharedMode
        ? { thread: await getThreadMetadata(threadId) }
        : await request("thread/read", { threadId, includeTurns: false });
      recordThreadPathsFromRpc(result);
      path = threadPaths.get(threadId);
    }
    if (!path) return { active: false, turn: null, lastEventAt: null };
    const child = relative(sessionsRoot, resolve(path));
    const safePath = child && !child.startsWith("..") ? resolveSafeRegularFile(sessionsRoot, child) : null;
    if (!safePath) throw new Error("Thread rollout is outside the Codex sessions directory");
    const turn =
      statSync(safePath).size > LARGE_ROLLOUT_BYTES
        ? (await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }))
            .data?.[0]
        : undefined;
    return liveSessions.read(safePath, { turn });
  }

  return {
    recordFileChangeDiff,
    recordReviewDiffsFromRpc,
    recordThreadPathsFromRpc,
    getThreadMetadata,
    readConversationHistory,
    readBrowserThread,
    readBrowserTurns,
    readLiveThread,
    subscribeSharedThread,
    invalidateHistory: (threadId: string) => conversationHistory.invalidate(threadId),
    clearHistory: () => conversationHistory.clear(),
    dropSubscription: (threadId: string) => sharedThreadSubscriptions.delete(threadId),
    markSubscribed: (threadId: string) => sharedThreadSubscriptions.set(threadId, Promise.resolve()),
    clearSubscriptions: () => sharedThreadSubscriptions.clear(),
    setSessionsRoot(root: string) {
      sessionsRoot = root;
    },
    get sessionsRoot() {
      return sessionsRoot;
    },
  };
}
