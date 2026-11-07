import { localizeAttribute, localizeText } from "../i18n.js";
import { findElement, findElements } from "./../dom.js";

// Owns message timestamps and worked-duration projections.
/** @param {import("./ports.js").FeatureOptions<"renderBatch" | "mutations" | "i18n" | "state" | "t", never, "timing">} options */
export function assembleTiming({ renderBatch, mutations, i18n, state, t }) {
  function timestampSeconds(value) {
    if (value instanceof Date) value = value.getTime();
    if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value)) value = Date.parse(value);
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number > 1e12 ? number / 1000 : number;
  }
  function messageClock(timestamp) {
    const seconds = timestampSeconds(timestamp);
    if (!seconds) return null;
    return new Intl.DateTimeFormat(i18n.locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(new Date(seconds * 1000));
  }
  function recordTurnTiming(turnId, turn = {}) {
    if (!turnId) return;
    const timing = { ...state.turnTimings.get(turnId) };
    const started = timestampSeconds(turn.startedAt ?? turn.startedAtMs),
      completed = timestampSeconds(turn.completedAt ?? turn.completedAtMs);
    if (started) timing.started = started;
    if (completed) timing.completed = completed;
    mutations.collection("turnTimings").set(turnId, timing);
    const timeline = state.turns.get(turnId);
    if (!timeline) return;
    if (timing.started) timeline.dataset.turnStartedAt = String(timing.started);
    if (timing.completed) timeline.dataset.turnCompletedAt = String(timing.completed);
  }
  function setMessageTime(el, timestamp, label) {
    const clock = messageClock(timestamp);
    if (!el || !clock) return;
    el.dataset.messageTime = clock;
    localizeAttribute(el, "title", label, { time: clock }, t);
    localizeAttribute(el, "aria-label", label, { time: clock }, t);
  }
  function formatWorkedDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 1000) return null;
    return i18n.format.duration(durationMs);
  }
  function turnDurationMs(turn = {}) {
    if (Number.isFinite(turn.durationMs)) return turn.durationMs;
    if (Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt))
      return Math.max(0, (turn.completedAt - turn.startedAt) * 1000);
    if (Number.isFinite(turn.startedAtMs) && Number.isFinite(turn.completedAtMs))
      return Math.max(0, turn.completedAtMs - turn.startedAtMs);
    return undefined;
  }
  function syncWorkedForDivider(turnId, durationMs) {
    if (renderBatch.active) return;
    const turn = state.turns.get(turnId),
      divider = state.dividers.get(turnId);
    if (!turn || !divider) return;
    if (Number.isFinite(durationMs)) turn.dataset.durationMs = String(durationMs);
    const hasActivity = Boolean(findElement("[data-agent-activity-group]:not([hidden])", turn)),
      hasFinal = [...findElements("[data-local-conversation-final-assistant]", turn)].some(
        (message) => message.textContent.trim() || findElement("img", message),
      );
    divider.hidden = !(hasActivity && hasFinal);
    const duration = formatWorkedDuration(Number(turn.dataset.durationMs));
    localizeText(findElement("span", divider), duration ? "common.workedDuration" : "common.worked", { duration }, t);
  }
  return {
    timestampSeconds,
    syncWorkedForDivider,
    recordTurnTiming,
    turnDurationMs,
    setMessageTime,
  };
}
