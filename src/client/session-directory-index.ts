import type { DirectoryEntry, DirectorySource } from "../shared/session-discovery.js";
/** Shared index coalesces sidebar and association reads without owning session state. */
export function createSessionDirectoryIndex(source: DirectorySource, { ttlMs = 60_000 } = {}) {
  let expiresAt = 0,
    generation = 0;
  let value: readonly DirectoryEntry[] = [];
  let pending: { generation: number; promise: Promise<readonly DirectoryEntry[]> } | null = null;
  async function read(): Promise<readonly DirectoryEntry[]> {
    if (Date.now() < expiresAt) return value;
    if (pending?.generation === generation) return pending.promise;
    const requested = generation;
    const promise = (async () => {
      const counts = new Map<string, { count: number; unassignedCount: number }>();
      const seen = new Set<string>();
      let cursor = "";
      do {
        const result = await source.directories(cursor);
        for (const entry of result.directories) {
          const previous = counts.get(entry.path) || { count: 0, unassignedCount: 0 };
          counts.set(entry.path, {
            count: previous.count + entry.count,
            unassignedCount: previous.unassignedCount + (entry.unassignedCount ?? entry.count),
          });
        }
        cursor = result.nextCursor || "";
        if (cursor && seen.has(cursor)) throw new Error("Repeated session directory cursor");
        seen.add(cursor);
      } while (cursor);
      if (requested !== generation) return read();
      value = Object.freeze(
        [...counts]
          .map(([path, counts]) => Object.freeze({ path, ...counts }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
      expiresAt = Date.now() + ttlMs;
      return value;
    })();
    pending = { generation: requested, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  }
  return {
    read,
    invalidate() {
      expiresAt = 0;
      generation++;
    },
  };
}
