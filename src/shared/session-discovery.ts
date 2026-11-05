import type { SessionSummary } from "./engine/types.js";
export interface DirectoryEntry {
  path: string;
  count: number;
  unassignedCount?: number;
}
export interface DirectoryPage {
  directories: DirectoryEntry[];
  nextCursor: string | null;
}
export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: string | null;
}
export interface DirectorySource {
  directories(cursor?: string): Promise<DirectoryPage>;
}
export interface DirectoryIndex {
  read(): Promise<readonly DirectoryEntry[]>;
  invalidate(): void;
}

/** Native workspace paths are metadata keys, not filesystem authorization. */
export function directoryKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || (path.startsWith("/") ? "/" : "");
}
export function sessionMatches(
  session: { id: string; name?: string; preview?: string; cwd?: string },
  query: { search?: string; directory?: string },
): boolean {
  if (query.directory !== undefined && directoryKey(session.cwd || "") !== directoryKey(query.directory)) return false;
  const search = (query.search || "").trim().toLowerCase();
  return !search || [session.name, session.preview, session.id, session.cwd].join(" ").toLowerCase().includes(search);
}
