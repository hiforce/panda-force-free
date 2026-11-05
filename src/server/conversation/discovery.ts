import { isRecord } from "../../shared/records.js";
import type { RpcRequest } from "../../shared/rpc-types.js";
import type { SessionSummary } from "../../shared/engine/types.js";

import type { DirectoryPage, SessionPage } from "../../shared/session-discovery.js";

export interface SessionDiscovery {
  history(options?: { search?: string; directory?: string; cursor?: string | null }): Promise<SessionPage>;
  directories(cursor?: string | null, assigned?: ReadonlySet<string>): Promise<DirectoryPage>;
}
import { directoryKey, sessionMatches } from "../../shared/session-discovery.js";
export { directoryKey } from "../../shared/session-discovery.js";

export function createSessionDiscovery({
  request,
  recordSessions = () => {},
}: {
  request: RpcRequest;
  recordSessions?: (result: unknown) => void;
}): SessionDiscovery {
  async function page(cursor: string | null) {
    const result = await request("thread/list", {
      limit: 100,
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Invalid engine session page");
    recordSessions(result);
    const sessions: SessionSummary[] = [];
    for (const entry of result.data) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      sessions.push({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : typeof entry.preview === "string" ? entry.preview : "",
        preview: typeof entry.preview === "string" ? entry.preview : "",
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        updatedAt:
          typeof entry.updatedAt === "number" || typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
        status:
          isRecord(entry.status) && typeof entry.status.type === "string" ? { type: entry.status.type } : undefined,
      });
    }
    const nextCursor = typeof result.nextCursor === "string" && result.nextCursor !== cursor ? result.nextCursor : null;
    return { sessions, nextCursor };
  }
  return {
    async history({ search = "", directory, cursor = null } = {}) {
      const query = search.trim().toLocaleLowerCase();
      const filter = directory === undefined ? undefined : directoryKey(directory);
      const found = new Map<string, SessionSummary>();
      const seen = new Set<string>();
      // A request is bounded even when sparse filters need several native pages.
      for (let index = 0; index < (query || filter !== undefined ? 10 : 1); index++) {
        const result = await page(cursor);
        for (const session of result.sessions) {
          if (!sessionMatches(session, { search: query, directory: filter })) continue;
          found.set(session.id, session);
        }
        cursor = result.nextCursor;
        if (!cursor || seen.has(cursor)) {
          cursor = null;
          break;
        }
        seen.add(cursor);
        if (found.size >= 50) break;
      }
      return { sessions: [...found.values()], nextCursor: cursor };
    },
    async directories(cursor: string | null = null, assigned = new Set<string>()) {
      const result = await page(cursor);
      const counts = new Map<string, { count: number; unassignedCount: number }>();
      for (const session of result.sessions) {
        const key = directoryKey(session.cwd || "");
        const value = counts.get(key) || { count: 0, unassignedCount: 0 };
        value.count++;
        if (!assigned.has(session.id)) value.unassignedCount++;
        counts.set(key, value);
      }
      return {
        directories: [...counts]
          .map(([path, counts]) => ({ path, ...counts }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        nextCursor: result.nextCursor,
      };
    },
  };
}
