import { isConversationCacheExpired } from "./conversation-policy.js";

// Memory, persistence revisions and invalidation share one lifecycle. An async
// cache read must never resurrect a deleted conversation or survive logout.
export function createConversationRepository({ persistent, maxThreads = 8 }) {
  const memory = new Map(),
    versions = new Map(),
    pendingWrites = new Map(),
    removed = new Set();
  let epoch = 0;
  function forget(id) {
    memory.delete(id);
    versions.delete(id);
    pendingWrites.delete(id);
  }
  function version(thread) {
    const tail = thread.turns?.at(-1);
    return JSON.stringify([thread.history?.revision, thread.status, tail?.id, tail?.status, tail?.error]);
  }
  function remember(thread, { persisted = false } = {}) {
    if (!thread?.id || removed.has(thread.id)) return;
    if (isConversationCacheExpired(thread)) {
      forget(thread.id);
      return;
    }
    memory.delete(thread.id);
    memory.set(thread.id, thread);
    while (memory.size > maxThreads) forget(memory.keys().next().value);
    const key = version(thread);
    if (persisted) versions.set(thread.id, key);
    else if (thread.history?.revision && versions.get(thread.id) !== key && pendingWrites.get(thread.id) !== key) {
      const generation = epoch;
      pendingWrites.set(thread.id, key);
      void Promise.resolve(persistent.put(thread))
        .then((written) => {
          if (generation === epoch && !removed.has(thread.id) && pendingWrites.get(thread.id) === key) {
            if (written) versions.set(thread.id, key);
            pendingWrites.delete(thread.id);
          }
        })
        .catch(() => {
          if (generation === epoch && pendingWrites.get(thread.id) === key) pendingWrites.delete(thread.id);
        });
    }
  }
  async function load(id) {
    if (removed.has(id)) return null;
    if (memory.has(id)) {
      const thread = memory.get(id);
      if (!isConversationCacheExpired(thread)) return thread;
      forget(id);
    }
    const generation = epoch,
      thread = await persistent.get(id);
    if (generation !== epoch || removed.has(id)) return null;
    // Prefer live data written while the persistent read was in flight.
    if (memory.has(id)) return memory.get(id);
    if (thread) remember(thread, { persisted: true });
    return memory.get(id) || null;
  }
  async function prune() {
    for (const [id, thread] of memory) if (isConversationCacheExpired(thread)) forget(id);
    const generation = epoch,
      snapshot = new Map(memory),
      ids = await persistent.prune();
    if (generation !== epoch) return;
    for (const id of ids || []) if (memory.get(id) === snapshot.get(id)) forget(id);
  }
  return {
    remember,
    load,
    forget,
    prune,
    has: (id) => memory.has(id),
    get: (id) => memory.get(id),
    async remove(id) {
      removed.add(id);
      forget(id);
      await persistent.remove(id);
    },
    async clear() {
      epoch++;
      memory.clear();
      versions.clear();
      pendingWrites.clear();
      await persistent.clear();
    },
    async summaries() {
      const generation = epoch,
        rows = await persistent.summaries();
      return generation === epoch ? rows : [];
    },
    saveSummaries: (rows) => persistent.saveSummaries(rows),
  };
}
