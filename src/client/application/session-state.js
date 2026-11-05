// The shared state object is a compatibility read model for existing views.
// Collection and active-session replacements have one write boundary here.
export function createSessionState(state) {
  return {
    replaceActive(thread) {
      state.active = thread;
    },
    replaceThreads(threads) {
      state.threads = threads;
    },
    setTurns(turns) {
      if (state.active) state.active = { ...state.active, turns };
    },
    addSummary(thread) {
      if (!state.threads.some((item) => item.id === thread.id)) state.threads.unshift(thread);
    },
    upsertSummary(thread) {
      const index = state.threads.findIndex((item) => item.id === thread.id);
      if (index < 0) state.threads.unshift(thread);
      else state.threads[index] = { ...state.threads[index], ...thread };
    },
    removeSummary(id) {
      state.threads = state.threads.filter((item) => item.id !== id);
    },
  };
}
