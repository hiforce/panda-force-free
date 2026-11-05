import { createHash } from "node:crypto";
import { isRecord } from "../../shared/records.js";
import {
  commandFromToolInput,
  contentChangeDiff,
  contentText,
  messageItem,
  outputDetails,
  reasoningItem,
} from "./rollout-items.js";
import { readRolloutEvent } from "./rollout-protocol.js";
export function newState() {
  return {
    active: false,
    turn: null,
    itemIndex: new Map(),
    commandCalls: new Map(),
    activeCommandId: null,
    userSequence: 0,
    eventSequence: 0,
    lastUserRecord: null,
    patchSequence: 0,
    questionTurns: new Map(),
    lastEventAt: null,
  };
}

function upsertItem(state, item) {
  if (!state.turn || !item?.id) return;
  const index = state.itemIndex.get(item.id);
  if (index === undefined) {
    state.itemIndex.set(item.id, state.turn.items.length);
    state.turn.items.push(item);
  } else state.turn.items[index] = { ...state.turn.items[index], ...item };
}

function finishActiveCommand(state, raw) {
  if (!state.turn || !state.activeCommandId) return;
  const index = state.itemIndex.get(state.activeCommandId);
  if (index === undefined) return;
  const current = state.turn.items[index];
  const details = outputDetails(raw);
  state.turn.items[index] = {
    ...current,
    status: details.running ? "inProgress" : details.failed ? "failed" : "completed",
    aggregatedOutput: details.output || current.aggregatedOutput || "",
    ...(details.exitCode === null ? {} : { exitCode: details.exitCode }),
  };
  if (!details.running) state.activeCommandId = null;
}

/** @param {unknown} input */
export function applyRolloutEvent(state, input) {
  if (!isRecord(input)) return state;
  // Metadata records still separate distinct inputs in the native journal.
  state.eventSequence += 1;
  if (typeof input.timestamp === "string") state.lastEventAt = input.timestamp;
  const event = readRolloutEvent(input);
  if (!event) return state;
  const payload = event.payload;
  if (event.type === "event_msg" && payload.type === "task_started") {
    state.active = true;
    state.itemIndex.clear();
    state.commandCalls.clear();
    state.activeCommandId = null;
    state.userSequence = 0;
    state.lastUserRecord = null;
    state.patchSequence = 0;
    state.turn = {
      id: payload.turn_id,
      status: "inProgress",
      itemsView: "full",
      items: [],
      ...(Number.isFinite(payload.started_at) ? { startedAt: payload.started_at } : {}),
    };
    return state;
  }
  if (!state.turn) return state;
  if (
    event.type === "event_msg" &&
    ["task_complete", "turn_aborted"].includes(payload.type) &&
    (!payload.turn_id || payload.turn_id === state.turn.id)
  ) {
    state.active = false;
    state.turn.status = payload.type === "turn_aborted" ? "interrupted" : "completed";
    const questions = state.questionTurns.get(state.turn.id);
    if (questions) questions.status = state.turn.status;
    if (Number.isFinite(payload.completed_at)) state.turn.completedAt = payload.completed_at;
    for (const item of state.turn.items) if (item.status === "inProgress") item.status = state.turn.status;
    state.activeCommandId = null;
    return state;
  }
  const legacyUser = event.type === "event_msg" && payload.type === "user_message";
  const nativeUser = event.type === "response_item" && payload.type === "message" && payload.role === "user";
  if (legacyUser || nativeUser) return applyUserRecord(state, event, payload);
  if (event.type === "event_msg" && payload.type === "patch_apply_end") {
    if (payload.turn_id && payload.turn_id !== state.turn.id) return state;
    const changes = Object.entries(payload.changes || {}).map(([path, change]) => ({
      path,
      kind: { type: change?.type || "update", move_path: change?.move_path || null },
      diff: change?.unified_diff || contentChangeDiff(change),
    }));
    if (changes.length) {
      state.patchSequence += 1;
      upsertItem(state, {
        id: `host-patch-${state.turn.id}-${state.patchSequence}`,
        type: "fileChange",
        status: payload.success === false ? "failed" : payload.status || "completed",
        changes,
        aggregatedOutput: payload.stderr || payload.stdout || "",
      });
    }
    return state;
  }
  if (event.type !== "response_item") return state;
  const message = messageItem(payload);
  if (message) {
    upsertItem(state, message);
    return state;
  }
  const reasoning = reasoningItem(payload);
  if (reasoning) {
    upsertItem(state, reasoning);
    return state;
  }
  // Host rollouts use function calls for questionnaires, even when native thread reads omit them.
  if (payload.type === "function_call" && /(?:^|[./_])request_user_input(?:_async)?$/.test(payload.name || ""))
    return applyQuestionRecord(state, payload);
  if (payload.type === "custom_tool_call") {
    const command = commandFromToolInput(payload.input);
    if (command) {
      const id = payload.id || payload.call_id;
      upsertItem(state, { id, type: "commandExecution", command, status: "inProgress", aggregatedOutput: "" });
      if (payload.call_id) state.commandCalls.set(payload.call_id, id);
      state.activeCommandId = id;
    }
    return state;
  }
  if (payload.type === "custom_tool_call_output") {
    const commandId = state.commandCalls.get(payload.call_id);
    if (commandId) state.activeCommandId = commandId;
    finishActiveCommand(state, payload.output);
    return state;
  }
  if (payload.type === "function_call_output") finishActiveCommand(state, payload.output);
  return state;
}

/** @param {import("./rollout-types.js").RolloutEvent} event @param {import("./rollout-types.js").RolloutPayload} payload */
function applyUserRecord(state, event, payload) {
  const legacyUser = event.type === "event_msg" && payload.type === "user_message";
  const nativeUser = event.type === "response_item" && payload.type === "message" && payload.role === "user";
  const text = legacyUser ? String(payload.message || "").trim() : contentText(payload.content).trim();
  const nativeImages =
    nativeUser && Array.isArray(payload.content)
      ? payload.content.filter((part) => isRecord(part) && ["input_image", "image"].includes(String(part.type)))
      : [];
  const content = [
    ...(text ? [{ type: "text", text }] : []),
    ...(payload.local_images || []).map((path) => ({ type: "localImage", path })),
    ...(payload.images || []).map((url) => ({ type: "image", url })),
  ];
  if (!content.length && !nativeImages.length) return state;
  const key = createHash("sha256")
    .update(text)
    .update("\0" + (nativeImages.length + (payload.images?.length || 0) + (payload.local_images?.length || 0)))
    .digest("hex");
  const timestamp = Date.parse(event.timestamp || ""),
    previous = state.lastUserRecord;
  if (
    previous &&
    previous.source !== event.type &&
    previous.key === key &&
    (previous.sequence === state.eventSequence - 1 ||
      (Number.isFinite(timestamp) && Math.abs(timestamp - previous.timestamp) <= 250))
  ) {
    state.lastUserRecord = null;
    return state;
  }
  state.lastUserRecord = { source: event.type, key, sequence: state.eventSequence, timestamp };
  state.userSequence += 1;
  if (content.length || nativeImages.length)
    for (const questions of state.questionTurns.values())
      for (const item of questions.items) {
        if (item.questionState === "earlier") continue;
        item.questionState = "earlier";
        if (questions.id === state.turn.id) upsertItem(state, item);
      }
  if (legacyUser && state.userSequence > 1 && content.length) {
    upsertItem(state, {
      id: `host-user-${state.turn.id}-${state.userSequence}`,
      type: "userMessage",
      ...(payload.client_id ? { clientId: payload.client_id } : {}),
      steer: true,
      content,
      status: "completed",
    });
  }
  return state;
}

/** @param {import("./rollout-types.js").RolloutPayload} payload */
function applyQuestionRecord(state, payload) {
  const item = {
    id: payload.id || payload.call_id,
    type: "dynamicToolCall",
    tool: payload.name,
    arguments: payload.arguments,
    status: "completed",
    ...(state.userSequence > 0 ? { questionUserSequence: state.userSequence } : {}),
  };
  const previousQuestion = state.questionTurns.get(state.turn.id)?.items.find((previous) => previous.id === item.id);
  if (previousQuestion?.questionState) Object.assign(item, { questionState: previousQuestion.questionState });
  upsertItem(state, item);
  const questions = state.questionTurns.get(state.turn.id) || {
    id: state.turn.id,
    status: state.turn.status,
    items: [],
  };
  if (!questions.items.some((existing) => existing.id === item.id)) questions.items.push(item);
  questions.items = questions.items.slice(-30);
  state.questionTurns.set(state.turn.id, questions);
  while (state.questionTurns.size > 32) state.questionTurns.delete(state.questionTurns.keys().next().value);
  return state;
}
