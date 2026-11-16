function isCapacityFailure(turn) {
  if (!["failed", "error"].includes(turn?.status)) return false;
  const error = turn.error || turn.failure;
  const code = error?.codexErrorInfo ?? error?.codex_error_info;
  return code === "serverOverloaded" || code === "server_overloaded";
}

// Recovery follows live terminal events, never errors found in history or a
// nonterminal error notification. Recheck the latest turn before sending input.
export function createAutoContinueRecovery(
  request,
  onError = (_error) => {},
  { enabled = false, schedule = setTimeout, cancel = clearTimeout, now = Date.now, random = Math.random } = {},
) {
  const threads = new Map();
  let generation = 0,
    nextRecoveryAt = 0;
  const stateFor = (id) => {
    let state = threads.get(id);
    if (!state) {
      state = {
        latestTurnId: null,
        active: false,
        attempts: 0,
        retry: null,
        completed: new Set(),
        automaticTurns: new Set(),
        ownedTurnId: null,
        latestTurn: null,
        generation: 0,
        recoveryStartedAt: null,
      };
      threads.set(id, state);
    }
    return state;
  };
  const clear = (state) => {
    if (state.retry) cancel(state.retry.timer);
    state.retry = null;
  };
  const recover = (threadId, state, turn) => {
    if (!enabled || state.ownedTurnId !== turn.id || state.retry || state.attempts >= 3) return;
    state.recoveryStartedAt ??= now();
    const deadline = state.recoveryStartedAt + 300000;
    if (now() >= deadline) return;
    const retry = {
      turnId: turn.id,
      timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
      sending: false,
    };
    state.retry = retry;
    const run = async () => {
      let deferred = false;
      try {
        if (state.retry !== retry || now() >= deadline) return;
        const { thread } = await request("thread/read", { threadId, includeTurns: true });
        if (state.retry !== retry) return;
        const latest = thread?.turns?.at(-1);
        if (
          state.active ||
          state.ownedTurnId !== retry.turnId ||
          now() >= deadline ||
          thread?.status?.type === "active" ||
          thread?.turns?.some((item) => item.status === "inProgress") ||
          latest?.id !== retry.turnId ||
          !isCapacityFailure(latest)
        )
          return;
        // This gate paces only automatic starts; ordinary conversations remain concurrent.
        if (now() < nextRecoveryAt) {
          retry.timer = schedule(run, nextRecoveryAt - now());
          deferred = true;
          return;
        }
        nextRecoveryAt = now() + 15000;
        retry.sending = true;
        state.attempts++;
        const claim = state.generation;
        const result = await request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: "Continue only unfinished work from the failed turn. Check saved results before repeating file changes or external actions.",
            },
          ],
        });
        const startedId = result?.turn?.id;
        if (state.generation !== claim || threads.get(threadId) !== state) return;
        if (startedId) state.ownedTurnId = startedId;
        if (startedId && !state.completed.has(startedId)) {
          state.automaticTurns.add(startedId);
          state.latestTurnId = startedId;
          state.active = true;
        } else if (startedId && state.latestTurnId === startedId && isCapacityFailure(state.latestTurn)) {
          if (state.retry === retry) state.retry = null;
          recover(threadId, state, state.latestTurn);
        }
      } catch (error) {
        onError(error);
      } finally {
        if (!deferred && state.retry === retry) state.retry = null;
      }
    };
    retry.timer = schedule(run, 15000 * 2 ** state.attempts * (1 + random() * 0.25));
  };
  return {
    onNotification(message) {
      if (!enabled) return;
      const { threadId, turn } = message.params || {};
      if (typeof threadId !== "string" || !threadId) return;
      if (["thread/closed", "thread/deleted"].includes(message.method)) {
        const state = threads.get(threadId);
        if (state) clear(state);
        threads.delete(threadId);
        return;
      }
      if (!["turn/started", "turn/completed"].includes(message.method) || typeof turn?.id !== "string" || !turn.id)
        return;
      const state = stateFor(threadId);
      if (message.method === "turn/started") {
        const automatic = state.automaticTurns.delete(turn.id);
        const awaitingAcknowledgement = state.retry?.sending === true;
        if (state.completed.has(turn.id) || (state.latestTurnId === turn.id && !automatic)) return;
        if (!awaitingAcknowledgement) clear(state);
        if (awaitingAcknowledgement && !automatic) state.ownedTurnId = null;
        else if (!automatic) {
          state.attempts = 0;
          state.recoveryStartedAt = null;
          if (state.ownedTurnId !== turn.id) state.ownedTurnId = null;
        } else state.ownedTurnId = turn.id;
        state.latestTurnId = turn.id;
        state.latestTurn = turn;
        state.active = true;
        return;
      }
      if (!["completed", "failed", "interrupted"].includes(turn.status) || state.completed.has(turn.id)) return;
      state.completed.add(turn.id);
      if (state.completed.size > 128) state.completed.delete(state.completed.values().next().value);
      // A terminal event without a matching live start can be historical
      // replay; it is never enough evidence to create a new turn.
      if (state.latestTurnId !== turn.id) return;
      state.latestTurnId = turn.id;
      state.latestTurn = turn;
      state.active = false;
      if (turn.status === "completed") {
        clear(state);
        state.attempts = 0;
        state.recoveryStartedAt = null;
        state.automaticTurns.clear();
      } else if (isCapacityFailure(turn)) recover(threadId, state, turn);
    },
    onExplicitInput(threadId) {
      if (!enabled || typeof threadId !== "string" || !threadId) return;
      const state = stateFor(threadId);
      clear(state);
      state.attempts = 0;
      state.recoveryStartedAt = null;
      state.ownedTurnId = null;
      state.automaticTurns.clear();
      state.generation = ++generation;
      return state.generation;
    },
    onSubmitted(threadId, turnId, claim) {
      if (!enabled || typeof turnId !== "string" || !turnId) return;
      const state = threads.get(threadId);
      if (!state || state.generation !== claim) return;
      state.ownedTurnId = turnId;
      // A fast terminal event may arrive before the RPC acknowledgement.
      if (state.latestTurnId === turnId && !state.active && isCapacityFailure(state.latestTurn))
        recover(threadId, state, state.latestTurn);
    },
    reset() {
      for (const state of threads.values()) clear(state);
      threads.clear();
    },
  };
}
