import type { StateScope } from "../contracts/ownership.js";
import type { SessionRepository } from "../contracts/repositories.js";
import { latestTokenUsage, tokenUsage } from "../../shared/engine/usage.js";
// Session collections and the current selection share one explicit write boundary.
export function createSessionState({ state, mutations }: StateScope<"sessionStore">): SessionRepository {
  function recordUsage(id: string, value: unknown, receivedAt?: number) {
    const decoded = tokenUsage(value);
    if (!decoded) return state.tokenUsage.get(id);
    if (decoded.updatedAt === undefined && typeof receivedAt === "number" && Number.isFinite(receivedAt))
      decoded.updatedAt = receivedAt;
    const usage = latestTokenUsage(state.tokenUsage.get(id), decoded);
    if (usage) mutations.collection("tokenUsage").set(id, usage);
    return usage;
  }
  return {
    recordTokenUsage(id, value, receivedAt) {
      if (!id) return;
      const usage = recordUsage(id, value, receivedAt);
      if (state.active?.id === id && usage) mutations.set("active", { ...state.active, tokenUsage: usage });
    },
    replaceActive(thread) {
      const usage = thread ? recordUsage(thread.id, thread.tokenUsage) : undefined;
      mutations.set(
        "active",
        thread ? { ...thread, ...(usage ? { tokenUsage: usage } : {}), turns: thread.turns || [] } : null,
      );
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
