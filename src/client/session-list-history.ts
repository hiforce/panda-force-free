import type { DataView } from "../shared/data-view.js";
import type { SessionSummary } from "../shared/engine/types.js";
import type { SessionPage } from "../shared/session-discovery.js";
import { harnessId } from "../shared/harness/presentation.js";
import { threadLastActivityAt } from "./conversation-policy.js";

export const SESSION_PAGE_SIZE = 30;

/** Retain authorized summary batches for back navigation. Share each outstanding cursor read. */
export function createSessionListHistory(read: (cursor: string) => Promise<SessionPage>) {
  const stored = new Map<string, DataView<SessionSummary>>();
  const cursors = new Set<string>();
  let cursor: string | null = "";
  let frontier = Number.POSITIVE_INFINITY;
  let initialized = false;
  let pending: Promise<void> | undefined;
  function more() {
    if (pending) return pending;
    if (cursor === null) return Promise.resolve();
    const requested = cursor;
    return (pending = read(requested)
      .then((result) => {
        for (const row of result.sessions) {
          stored.set(row.id, row);
          const activity = threadLastActivityAt(row);
          if (activity && !harnessId(row.id)) frontier = Math.min(frontier, activity);
        }
        cursors.add(requested);
        if (result.nextCursor !== null && cursors.has(result.nextCursor)) cursor = null;
        else cursor = result.nextCursor;
        initialized = true;
      })
      .finally(() => {
        pending = undefined;
      }));
  }
  return {
    get initialized() {
      return initialized;
    },
    get hasMore() {
      return cursor !== null;
    },
    more,
    rows(live: readonly DataView<SessionSummary>[], removed: (id: string) => boolean) {
      const rows = new Map(stored);
      for (const row of live) {
        const previous = rows.get(row.id);
        rows.set(row.id, { ...previous, ...row, model: row.model || previous?.model });
      }
      return [...rows.values()]
        .filter((row) => !removed(row.id) && (!initialized || cursor === null || threadLastActivityAt(row) >= frontier))
        .sort((a, b) => threadLastActivityAt(b) - threadLastActivityAt(a));
    },
  };
}
