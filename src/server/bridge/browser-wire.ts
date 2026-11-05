import { isRecord } from "../../shared/records.js";

export interface BrowserWire {
  register(client: object, engineEvents: boolean): void;
  stringify(client: object, message: unknown): string;
}
const LEGACY_TYPES = new Map<string, string>([
  ["engine/request", "codex/request"],
  ["engine/notification", "codex/notification"],
]);

/** Cached clients keep their wire vocabulary across a rollout; internal events stay portable. */
export function createBrowserWire(): BrowserWire {
  const current = new WeakSet<object>();
  return {
    register(client, engineEvents) {
      if (engineEvents) current.add(client);
      else current.delete(client);
    },
    stringify(client, message) {
      const type = isRecord(message) && typeof message.type === "string" ? message.type : "";
      const legacyType = LEGACY_TYPES.get(type);
      const output =
        !current.has(client) && legacyType && isRecord(message) ? { ...message, type: legacyType } : message;
      return JSON.stringify(output) ?? "null";
    },
  };
}
