export function assembleTurnFrames({ state, mutations, $ }) {
  function ensureTurnTimeline(turnId, root = $("#conversation")) {
    let turn = state.turns.get(turnId);
    if (turn?.isConnected) return turn;
    turn = document.createElement("article");
    turn.className = "turn assistant-turn native-turn-timeline";
    turn.dataset.turnId = turnId;
    turn.innerHTML =
      '<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="worked-for-divider" data-worked-for-divider hidden><span>Worked</span><div></div></div><div class="turn-final-slot"></div>';
    root.append(turn);
    mutations.collection("turns").set(turnId, turn);
    mutations.collection("dividers").set(turnId, turn.querySelector("[data-worked-for-divider]"));
    const timing = state.turnTimings.get(turnId);
    if (timing) {
      if (timing.started) turn.dataset.turnStartedAt = String(timing.started);
      if (timing.completed) turn.dataset.turnCompletedAt = String(timing.completed);
    }
    return turn;
  }
  return { ensureTurnTimeline };
}
