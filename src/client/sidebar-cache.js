const MAX_BYTES = 64 * 1024;
const TTL_MS = 48 * 60 * 60 * 1000;

// Store only the small, visible session list. Chat items stay in IndexedDB.
export function createSidebarCache({ storage, key, now = Date.now }) {
  let cached = null;
  let disabled = false;
  try {
    const raw = storage.get(key);
    if (raw && raw.length <= MAX_BYTES) {
      const value = JSON.parse(raw);
      if (
        value?.version === 1 &&
        Array.isArray(value.threads) &&
        value.threads.length <= 50 &&
        value.threads.every(
          (thread) =>
            thread &&
            typeof thread.id === "string" &&
            thread.id.length > 0 &&
            thread.id.length <= 256 &&
            (!thread.status || typeof thread.status.type === "string") &&
            ["name", "preview", "cwd", "model", "modelProvider", "reasoningEffort"].every(
              (field) => thread[field] == null || typeof thread[field] === "string",
            ),
        ) &&
        typeof value.home === "string" &&
        Number.isFinite(value.updatedAt) &&
        value.updatedAt <= now() + 300_000 &&
        now() - value.updatedAt < TTL_MS &&
        Number.isSafeInteger(value.visibility?.revision) &&
        value.visibility.revision >= 0 &&
        value.visibility.hiddenProjects &&
        typeof value.visibility.hiddenProjects === "object" &&
        !Array.isArray(value.visibility.hiddenProjects)
      )
        cached = value;
    }
  } catch {}
  let hasThreads = Boolean(cached);
  const write = () => {
    if (!cached?.visibility || !hasThreads) return;
    const text = JSON.stringify(cached);
    if (new TextEncoder().encode(text).length <= MAX_BYTES) storage.set(key, text);
    else storage.remove(key);
  };
  return {
    read: () => cached,
    saveThreads(threads, home = "") {
      if (disabled) return;
      hasThreads = true;
      cached = {
        ...cached,
        version: 1,
        home,
        updatedAt: now(),
        threads: threads.slice(0, 50).map((thread) => {
          const summary = { id: thread.id };
          for (const field of ["name", "preview", "cwd", "model", "modelProvider", "reasoningEffort"])
            if (typeof thread[field] === "string")
              summary[field] = thread[field].slice(0, field === "cwd" ? 2048 : 240);
          for (const field of [
            "createdAt",
            "updatedAt",
            "recencyAt",
            "lastActivityAt",
            "projectless",
            "canAcceptDirectInput",
          ])
            if (["number", "boolean"].includes(typeof thread[field])) summary[field] = thread[field];
          if (typeof thread.status?.type === "string") summary.status = { type: thread.status.type };
          return summary;
        }),
      };
      write();
    },
    saveVisibility(visibility) {
      if (disabled) return;
      cached = { version: 1, home: "", updatedAt: now(), threads: [], ...cached, visibility };
      write();
    },
    remove(id) {
      if (!cached || disabled) return;
      cached = { ...cached, threads: cached.threads.filter((thread) => thread.id !== id) };
      write();
    },
    clear({ disableWrites = false } = {}) {
      cached = null;
      hasThreads = false;
      disabled = disableWrites;
      storage.remove(key);
    },
  };
}
