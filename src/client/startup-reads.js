const GLOBAL_KEY = "__codexWebuiStartupReads";

export function startStartupReads({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (globalThis[GLOBAL_KEY]) return;
  const read = async (path, options, transform = (value) => value) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(path, { cache: "no-store", ...options, signal: controller.signal });
      if (!response.ok) return null;
      return transform(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  globalThis[GLOBAL_KEY] = {
    config: read("/api/config"),
    visibility: read("/api/projects/visibility"),
    threads: read(
      "/api/rpc",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: 0,
          method: "thread/list",
          params: { limit: 50, sortKey: "recency_at", sortDirection: "desc" },
        }),
      },
      (message) => (message.type === "rpc/result" ? message.result : null),
    ),
  };
}

export async function takeStartupRead(name, fallback) {
  const reads = globalThis[GLOBAL_KEY];
  const pending = reads?.[name];
  if (pending) {
    delete reads[name];
    const value = await pending;
    if (value != null) return value;
  }
  return fallback();
}
