import type { SessionTool, SessionToolRegistry } from "../contracts/session-workspace.js";

/** Only trusted application composition registers actions; a pinned tool never grants engine permissions. */
export function createSessionToolRegistry(definitions: readonly SessionTool[]): SessionToolRegistry {
  const entries = new Map<string, SessionTool>();
  for (const tool of definitions) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(tool.id) || entries.has(tool.id) || typeof tool.activate !== "function")
      throw new Error("Invalid or duplicate session tool: " + tool.id);
    entries.set(tool.id, Object.freeze({ ...tool }));
  }
  return Object.freeze({ all: () => [...entries.values()], get: (id: string) => entries.get(id) });
}
