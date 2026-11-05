const terminalStatuses = new Set(["completed", "interrupted", "cancelled", "canceled", "failed", "error", "errored"]);

// One record per session owns native turn identity and local failures. DOM and
// thread summaries are projections; navigating between sessions never resets it.
export function createSessionRuntime() {
  const sessions = new Map();
  function ensure(id) {
    if (!sessions.has(id)) sessions.set(id, {});
    return sessions.get(id);
  }
  function acceptsTurn(id, turnId) {
    const entry = sessions.get(id),
      running = entry?.turn?.status === "inProgress" ? entry.turn.id : "";
    return !turnId || (!entry?.retired?.includes(turnId) && (!running || running === turnId));
  }
  function latestStatus(thread, history = thread) {
    const runtime = sessions.get(thread?.id)?.turn,
      tail = history?.turns?.at(-1);
    if (!runtime) return tail?.status || "";
    // A notification may arrive before its turn is persisted. The tail captured
    // with that event distinguishes old history from genuinely newer history.
    if (!tail || runtime.id === tail.id || runtime.historyTailId === tail.id)
      return runtime.status === "idle" && runtime.id === tail?.id ? tail.status : runtime.status || tail?.status || "";
    return tail.status || runtime.status || "";
  }
  function activeTurnId(thread) {
    if (!thread?.id) return "";
    const status = latestStatus(thread),
      entry = sessions.get(thread.id),
      tail = thread.turns?.at(-1);
    if (terminalStatuses.has(status)) return "";
    if (status === "inProgress") {
      if (tail?.status === "inProgress" && tail.id !== entry?.turn?.historyTailId && tail.id !== entry?.turn?.id)
        return tail.id;
      return (
        (entry?.turn?.status === "inProgress" ? entry.turn.id : "") || (tail?.status === "inProgress" ? tail.id : "")
      );
    }
    return entry?.turn?.status === "inProgress" ? entry.turn.id : "";
  }
  /** @param {string} id @param {import("../shared/data-contracts.js").SessionActivity} change */
  function update(id, { status, turnId, turnStatus, completed = false, historyTailId } = {}) {
    if (!id || (turnId && sessions.get(id)?.retired?.includes(turnId)) || (completed && !acceptsTurn(id, turnId)))
      return false;
    const entry = ensure(id);
    if (turnId && entry.turn?.id && turnId !== entry.turn.id)
      entry.retired = [...(entry.retired || []), entry.turn.id].slice(-32);
    if (turnId && turnStatus) entry.turn = { id: turnId, status: turnStatus, historyTailId };
    // An uncorrelated idle snapshot can belong to the previous request. Only
    // a matching turn lifecycle event ends a known running turn.
    if (status && status.type !== "active" && (turnId || status.type !== "idle") && entry.turn?.status === "inProgress")
      entry.turn = { ...entry.turn, status: status.type === "idle" ? "idle" : "failed" };
    return true;
  }
  return {
    get: (id) => sessions.get(id),
    latestStatus,
    activeTurnId,
    acceptsTurn,
    update,
    observeTurn(id, turn, historyTailId) {
      if (!id || !turn?.id) return;
      // Rendering an old turn is not a lifecycle event for the active turn.
      if (!acceptsTurn(id, turn.id)) {
        if (historyTailId !== turn.id || sessions.get(id)?.retired?.includes(turn.id)) return;
        // A newly persisted tail can reveal a start notification missed offline.
        if (turn.status === "inProgress")
          update(id, { status: { type: "active" }, turnId: turn.id, turnStatus: turn.status, historyTailId });
        else return;
      }
      update(id, {
        turnId: turn.id,
        turnStatus: turn.status,
        historyTailId,
        status: { type: turn.status === "inProgress" ? "active" : "idle" },
        completed: turn.status !== "inProgress",
      });
    },
    rememberError(id, error) {
      if (id && acceptsTurn(id, error?.turnId)) ensure(id).error = error;
    },
    clearError(id) {
      const entry = sessions.get(id);
      if (entry) delete entry.error;
    },
    remove: (id) => sessions.delete(id),
    clear: () => sessions.clear(),
  };
}
