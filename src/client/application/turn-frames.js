import { setMessageHtml } from "../i18n.js";
import { requireElement } from "./../dom.js";
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "$", never, "turnFrames">} options */
export function assembleTurnFrames({ state, mutations, $ }) {
  function ensureTurnTimeline(turnId, root = $("#conversation")) {
    let turn = state.turns.get(turnId);
    if (turn?.isConnected) return turn;
    turn = document.createElement("article");
    turn.className = "turn assistant-turn native-turn-timeline";
    turn.dataset.turnId = turnId;
    setMessageHtml(
      turn,
      '<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="worked-for-divider" data-worked-for-divider hidden><span><span data-pf-message="common.worked">Worked</span></span><div></div></div><div class="turn-final-slot"></div>',
    );
    root.append(turn);
    mutations.collection("turns").set(turnId, turn);
    mutations.collection("dividers").set(turnId, requireElement("[data-worked-for-divider]", turn));
    const timing = state.turnTimings.get(turnId);
    if (timing) {
      if (timing.started) turn.dataset.turnStartedAt = String(timing.started);
      if (timing.completed) turn.dataset.turnCompletedAt = String(timing.completed);
    }
    return turn;
  }
  return { ensureTurnTimeline };
}
