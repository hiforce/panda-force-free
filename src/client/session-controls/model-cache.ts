import { STORAGE_KEYS } from "../storage.js";
interface ModelSettings {
  model?: string;
  effort?: string;
}
interface ModelCacheStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** This optional preference cache never owns remote session settings or recovery receipts. */
export function createSessionModelCache(storage: ModelCacheStorage) {
  const readAll = () => {
    const entries: Record<string, ModelSettings> = Object.create(null);
    try {
      const parsed = JSON.parse(storage.get(STORAGE_KEYS.sessionModelCache) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return entries;
      for (const [id, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const fields = value as Record<string, unknown>;
        entries[id] = {
          ...(typeof fields.model === "string" ? { model: fields.model } : {}),
          ...(typeof fields.effort === "string" ? { effort: fields.effort } : {}),
        };
      }
    } catch {
      /* Malformed optional preferences are discarded; the next write repairs the cache. */
    }
    return entries;
  };
  return {
    read(id?: string): ModelSettings | null {
      return id ? (readAll()[id] ?? null) : null;
    },
    write(id: string, settings: ModelSettings) {
      if (!id) return;
      const all = readAll();
      all[id] = { ...all[id], ...settings };
      storage.set(STORAGE_KEYS.sessionModelCache, JSON.stringify(all));
    },
    clear(id?: string) {
      if (!id) return;
      const all = readAll();
      if (!Object.hasOwn(all, id)) return;
      delete all[id];
      storage.set(STORAGE_KEYS.sessionModelCache, JSON.stringify(all));
    },
  };
}
