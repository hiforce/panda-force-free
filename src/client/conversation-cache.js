import { reportDiagnostic } from "../shared/diagnostics.js";
import { canonicalData } from "../shared/read-model.js";
import { isConversationCacheExpired, threadLastActivityAt } from "./conversation-policy.js";

const DATABASE = "panda-force-conversations-v1",
  STORE = "entries",
  SIDEBAR = "__sidebar__";
export { CONVERSATION_CACHE_TTL_MS, isConversationCacheExpired } from "./conversation-policy.js";

// IndexedDB keeps chat text off the synchronous localStorage/render path.
/** @param {{identity?: string | null; indexedDB?: IDBFactory; maxThreads?: number; maxItems?: number}} options */
export function createConversationCache({ identity = null, indexedDB, maxThreads = 8, maxItems = 100 } = {}) {
  const databaseName = typeof identity === "string" && identity ? DATABASE + ":" + identity : null;
  try {
    indexedDB ??= globalThis.indexedDB;
  } catch {}
  let databasePromise,
    lastWrite = 0,
    closed = false;
  const removed = new Set();
  let epoch = 0;
  function expired(entry, now) {
    return (
      entry.id !== SIDEBAR &&
      isConversationCacheExpired(entry.thread, {
        now,
        cachedAt: entry.activityAt || entry.updatedAt,
      })
    );
  }
  function pruneEntries(store, now, set = (_entries) => {}) {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = [],
        evicted = [];
      for (const entry of request.result) {
        if (entry.id === SIDEBAR) continue;
        if (expired(entry, now)) {
          store.delete(entry.id);
          evicted.push(entry.id);
        } else entries.push(entry);
      }
      entries.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const entry of entries.slice(maxThreads)) {
        store.delete(entry.id);
        evicted.push(entry.id);
      }
      set(evicted);
    };
  }
  function database() {
    if (!indexedDB || !databaseName || closed) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    const pending = new Promise((resolve) => {
      let request;
      let abandoned = false;
      try {
        request = indexedDB.open(databaseName, 1);
      } catch (error) {
        reportDiagnostic("conversation-cache.open", error);
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => {
        if (closed || abandoned) {
          request.result.close();
          resolve(null);
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        reportDiagnostic("conversation-cache.open", request.error);
        resolve(null);
      };
      request.onblocked = () => {
        abandoned = true;
        resolve(null);
      };
    });
    databasePromise = pending;
    void pending.then((db) => {
      if (!db && databasePromise === pending) databasePromise = null;
    });
    return pending;
  }
  async function transaction(mode, action) {
    const generation = epoch;
    try {
      const db = await database();
      if (!db || closed || generation !== epoch) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, mode),
          store = tx.objectStore(STORE);
        let result = null;
        action(store, (value) => (result = value));
        tx.oncomplete = () => resolve(!closed && generation === epoch ? result : null);
        tx.onerror = tx.onabort = () => {
          reportDiagnostic("conversation-cache.transaction", tx.error);
          resolve(null);
        };
      });
    } catch (error) {
      reportDiagnostic("conversation-cache.transaction", error);
      return null;
    }
  }
  function compact(thread) {
    let remaining = maxItems;
    const turns = [];
    for (let index = (thread.turns || []).length - 1; index >= 0 && remaining > 0; index--) {
      const turn = thread.turns[index],
        items = (turn.items || []).slice(-remaining);
      if (items.length || index === thread.turns.length - 1) {
        turns.unshift({ ...turn, items });
        remaining -= items.length;
      }
    }
    const first = turns[0],
      oldest = first?.items[0],
      oldestKey = oldest ? `${first.id}:${oldest.id}` : null;
    const truncated = (thread.turns || []).reduce((count, turn) => count + (turn.items || []).length, 0) > maxItems;
    return {
      ...thread,
      turns,
      ...(thread.history
        ? {
            history: {
              ...thread.history,
              oldestItemId: oldestKey,
              nextCursor: truncated ? oldestKey : thread.history.nextCursor,
            },
          }
        : {}),
    };
  }
  return {
    close() {
      closed = true;
      epoch++;
      void databasePromise?.then((database) => database?.close());
      databasePromise = null;
    },
    async get(id) {
      if (removed.has(id)) return null;
      return transaction("readwrite", (store, set) => {
        const request = store.get(id);
        request.onsuccess = () => {
          const entry = request.result;
          if (entry && expired(entry, Date.now())) store.delete(id);
          else set(entry?.thread || null);
        };
      });
    },
    async put(thread) {
      if (!thread?.id || removed.has(thread.id)) return;
      const value = canonicalData(compact(thread));
      const generation = epoch;
      return transaction("readwrite", (store, set) => {
        if (generation !== epoch) return;
        const request = store.get(thread.id);
        request.onsuccess = () => {
          const now = Date.now(),
            activityAt =
              threadLastActivityAt(thread) * 1000 || request.result?.activityAt || request.result?.updatedAt || now;
          if (
            generation !== epoch ||
            removed.has(thread.id) ||
            isConversationCacheExpired(thread, { now, cachedAt: activityAt })
          )
            store.delete(thread.id);
          else {
            lastWrite = Math.max(now, lastWrite + 1);
            store.put({
              id: thread.id,
              updatedAt: lastWrite,
              activityAt,
              thread: value,
            });
            set(true);
          }
          pruneEntries(store, now);
        };
      });
    },
    async summaries() {
      return transaction("readonly", (store, set) => {
        const request = store.get(SIDEBAR);
        request.onsuccess = () => set(request.result?.threads || []);
      });
    },
    async saveSummaries(threads) {
      const generation = epoch;
      return transaction("readwrite", (store) => {
        if (generation !== epoch) return;
        store.put({
          id: SIDEBAR,
          threads: threads
            .filter((thread) => !removed.has(thread.id))
            .slice(0, 50)
            .map(({ turns, history, ...summary }) => summary),
        });
      });
    },
    async prune() {
      return transaction("readwrite", (store, set) => pruneEntries(store, Date.now(), set));
    },
    async remove(id) {
      removed.add(id);
      return transaction("readwrite", (store) => {
        store.delete(id);
        const request = store.get(SIDEBAR);
        request.onsuccess = () => {
          if (request.result)
            store.put({
              ...request.result,
              threads: request.result.threads.filter((thread) => thread.id !== id),
            });
        };
      });
    },
    async clear() {
      epoch++;
      return transaction("readwrite", (store) => store.clear());
    },
  };
}
