import type { StateScope } from "../contracts/ownership.js";
import type { SessionRepository } from "../contracts/repositories.js";
// Session collections and the current selection share one explicit write boundary.
export function createSessionState({ state, mutations }: StateScope<"sessionStore">): SessionRepository {
  return {
    replaceActive(thread) {
      mutations.set("active", thread ? { ...thread, turns: thread.turns || [] } : null);
    },
    replaceThreads(threads) {
      mutations.set("threads", threads);
    },
    setTurns(turns) {
      if (state.active) mutations.set("active", { ...state.active, turns });
    },
    addSummary(thread) {
      if (!state.threads.some((item) => item.id === thread.id)) mutations.set("threads", [thread, ...state.threads]);
    },
    upsertSummary(thread) {
      const index = state.threads.findIndex((item) => item.id === thread.id);
      if (index < 0) mutations.set("threads", [thread, ...state.threads]);
      else
        mutations.set(
          "threads",
          state.threads.map((entry, at) => (at === index ? { ...entry, ...thread } : entry)),
        );
    },
    removeSummary(id) {
      mutations.set(
        "threads",
        state.threads.filter((item) => item.id !== id),
      );
    },
  };
}
