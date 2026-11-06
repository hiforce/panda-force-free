import { storage, STORAGE_KEYS } from "../storage.js";
import type {
  SessionToolDocument,
  SessionToolRegistry,
  SessionToolStorage,
  ToolPreferences,
} from "../contracts/session-workspace.js";

const emptyDocument = (): SessionToolDocument => ({ note: "", checks: [] });
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Browser notes and tool preferences are isolated by authenticated identity and session. */
export function createSessionToolStorage(
  registry: SessionToolRegistry,
  identity?: string,
  persistence: Pick<typeof storage, "getJson" | "setJson"> = storage,
): SessionToolStorage {
  const documents = new Map<string, SessionToolDocument>();
  const defaults = {
    pinned: ["files", "changes", "terminal"],
    disabled: registry
      .all()
      .filter((x) => !x.enabled)
      .map((x) => x.id),
  };
  const saved: unknown = identity ? persistence.getJson(STORAGE_KEYS.sessionToolsFor(identity), null) : null;
  const known = (values: unknown): string[] =>
    Array.isArray(values)
      ? [...new Set(values.filter((id): id is string => typeof id === "string" && Boolean(registry.get(id))))]
      : [];
  const preferences: ToolPreferences =
    isObject(saved) && Array.isArray(saved.pinned) && Array.isArray(saved.disabled)
      ? { pinned: known(saved.pinned).slice(0, 3), disabled: known(saved.disabled) }
      : defaults;
  preferences.pinned = preferences.pinned.filter((id) => !preferences.disabled.includes(id));
  const persist = () => {
    if (identity) persistence.setJson(STORAGE_KEYS.sessionToolsFor(identity), preferences);
  };
  function readDocument(id: string): SessionToolDocument {
    if (documents.has(id)) return structuredClone(documents.get(id)!);
    const value: unknown = identity ? persistence.getJson(STORAGE_KEYS.sessionToolDataFor(identity, id), null) : null;
    const document = emptyDocument();
    if (isObject(value)) {
      if (typeof value.note === "string") document.note = value.note.slice(0, 20000);
      if (Array.isArray(value.checks)) {
        const ids = new Set<string>();
        for (const item of value.checks.slice(0, 30)) {
          if (!isObject(item) || typeof item.id !== "string" || typeof item.text !== "string" || ids.has(item.id))
            continue;
          ids.add(item.id);
          document.checks.push({ id: item.id, text: item.text.slice(0, 250), done: item.done === true });
        }
      }
    }
    documents.set(id, document);
    return structuredClone(document);
  }
  return {
    preferences: () => structuredClone(preferences),
    pin(id) {
      if (!registry.get(id) || preferences.disabled.includes(id)) return false;
      if (preferences.pinned.includes(id)) preferences.pinned = preferences.pinned.filter((x) => x !== id);
      else if (preferences.pinned.length < 3) preferences.pinned.push(id);
      else return false;
      persist();
      return true;
    },
    move(id, direction) {
      const from = preferences.pinned.indexOf(id),
        to = from + Math.sign(direction);
      if (from < 0 || to < 0 || to >= preferences.pinned.length) return;
      [preferences.pinned[from], preferences.pinned[to]] = [preferences.pinned[to], preferences.pinned[from]];
      persist();
    },
    enable(id, enabled) {
      if (!registry.get(id)) return;
      preferences.disabled = preferences.disabled.filter((x) => x !== id);
      if (!enabled) {
        preferences.disabled.push(id);
        preferences.pinned = preferences.pinned.filter((x) => x !== id);
      }
      persist();
    },
    document: readDocument,
    saveDocument(id, value) {
      if (!id) return false;
      const document: SessionToolDocument = {
        note: value.note.slice(0, 20000),
        checks: value.checks
          .slice(0, 30)
          .map((item) => ({ id: item.id, text: item.text.slice(0, 250), done: item.done })),
      };
      documents.set(id, structuredClone(document));
      if (!identity) return false;
      const key = STORAGE_KEYS.sessionToolDataFor(identity, id);
      persistence.setJson(key, document);
      return JSON.stringify(persistence.getJson(key, null)) === JSON.stringify(document);
    },
  };
}
