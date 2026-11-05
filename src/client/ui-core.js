import { canonicalAttachmentUrl } from "../shared/attachment-urls.js";

export const DEFAULT_TURN_PAGE_SIZE = 20;

// Match the CLI's empty-or-unedited-recall gate, including multiline boundaries.
export function createComposerHistory() {
  let persistent = [],
    replay = [],
    local = [],
    cursor = null,
    lastText = null;
  const reset = () => {
    cursor = null;
    lastText = null;
  };
  const copy = (entry) => ({
    text: entry.text,
    mentions: (entry.mentions || []).map((mention) => ({ ...mention })),
    ...(entry.attachments?.length ? { attachments: entry.attachments.map((attachment) => ({ ...attachment })) } : {}),
  });
  const valid = (entry) => typeof entry?.text === "string" && (entry.text || entry.attachments?.length);
  const key = (entry) =>
    JSON.stringify([
      entry.text,
      (entry.attachments || []).map((attachment) => [
        attachment.kind,
        attachment.path || canonicalAttachmentUrl(attachment.url) || attachment.url,
      ]),
    ]);
  const entries = () => {
    const known = new Set([...persistent, ...local].map(key));
    return [...persistent, ...replay.filter((entry) => !known.has(key(entry))), ...local];
  };
  return {
    reset,
    setPersistent(values) {
      persistent = values.filter(valid).map(copy);
      reset();
    },
    setReplay(values) {
      replay = values.filter(valid).map(copy);
      reset();
    },
    record(entry) {
      if (!valid(entry)) return;
      const value = copy(entry);
      if (JSON.stringify(local.at(-1)) !== JSON.stringify(value)) local.push(value);
      reset();
    },
    navigate(direction, text, selectionStart, selectionEnd = selectionStart) {
      const history = entries();
      if (!history.length || selectionStart !== selectionEnd) return null;
      if (text && (text !== lastText || (selectionStart !== 0 && selectionStart !== text.length))) return null;
      let next;
      if (direction < 0) {
        if (cursor === 0) return null;
        next = cursor === null ? history.length - 1 : cursor - 1;
      } else {
        if (cursor === null) return null;
        next = cursor + 1;
      }
      if (next >= history.length) {
        reset();
        return { text: "", mentions: [] };
      }
      cursor = next;
      lastText = history[next].text;
      return copy(history[next]);
    },
  };
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    isCurrent(value) {
      return value === generation;
    },
    get current() {
      return generation;
    },
  };
}

export function createTurnWindow(turns, pageSize = DEFAULT_TURN_PAGE_SIZE, currentStart, loadMore = 0) {
  const total = Array.isArray(turns) ? turns.length : 0;
  const safePage = Math.max(1, pageSize);
  const baseStart = currentStart == null ? Math.max(0, total - safePage) : Math.max(0, Math.min(currentStart, total));
  const start = Math.max(0, baseStart - Math.max(0, loadMore));
  return { visible: turns.slice(start), hiddenCount: start, start, total };
}

export function selectModelState(models, requestedModel) {
  const catalog = Array.isArray(models) ? models : [];
  const selected = catalog.find((item) => item.model === requestedModel) ||
    catalog.find((item) => item.isDefault) ||
    catalog[0] || { model: "", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] };
  const efforts = (selected.supportedReasoningEfforts || []).map((item) => item.reasoningEffort).filter(Boolean);
  const effort = efforts.includes(selected.defaultReasoningEffort)
    ? selected.defaultReasoningEffort
    : efforts[0] || selected.defaultReasoningEffort || "medium";
  return { model: selected.model, effort, efforts: efforts.length ? efforts : [effort] };
}

export function filterAppModels(models) {
  return (Array.isArray(models) ? models : []).filter((model) =>
    [model?.model, model?.id, model?.displayName].some((value) => /^gpt(?:[-_.\s]|$)/i.test(String(value || ""))),
  );
}

/** @param {{followUpType?: string; composerMode?: string; cloudStartingState?: string | null; isBackgroundSubagentsPanelVisible?: boolean; isGoalModeActive?: boolean; isPlanModeActive?: boolean; placeholderText?: string | null; isHome?: boolean}} options */
export function resolveComposerPlaceholder({
  followUpType,
  composerMode = "local",
  cloudStartingState,
  isBackgroundSubagentsPanelVisible = false,
  isGoalModeActive = false,
  isPlanModeActive = false,
  placeholderText,
  isHome = false,
} = {}) {
  if (isGoalModeActive) return "Describe your goal, define measurable outcomes for best results";
  if (isPlanModeActive) return "Describe your task to generate a plan...";
  if (placeholderText != null) return placeholderText;
  if (followUpType === "cloud") {
    if (composerMode === "local") return "Create a new local task that references this cloud task";
    if (cloudStartingState === "working-tree")
      return "Create a new cloud task that includes your current code and will reference this task";
    return "Follow-up to this cloud task";
  }
  if (followUpType === "local") {
    if (composerMode === "cloud") return "Follow-up in a new cloud task";
    return isBackgroundSubagentsPanelVisible
      ? "Ask for follow up changes or @ to tag an agent"
      : "Ask for follow-up changes";
  }
  if (isHome && composerMode === "local") return "Do anything";
  return composerMode === "cloud"
    ? "Ask PandaForce to do anything in the cloud"
    : "Ask ChatGPT anything. @ to use plugins or mention files";
}

export function getComposerAutocomplete(text, cursor = text.length) {
  const value = String(text || "");
  const end = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : value.length, value.length));
  const before = value.slice(0, end);
  const slash = before.match(/^\s*\/([^\s/]*)$/);
  if (slash) {
    const start = before.indexOf("/");
    return { type: "slash", query: slash[1], start, end };
  }
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!mention) return null;
  const start = before.lastIndexOf("@");
  return { type: "mention", query: mention[1], start, end };
}

export function applyComposerSuggestion(text, match, replacement) {
  const value = String(text || "");
  if (!match || match.start < 0 || match.end < match.start) return { text: value, cursor: value.length };
  const before = value.slice(0, match.start);
  const after = value.slice(match.end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const inserted = String(replacement || "") + (needsSpace ? " " : "");
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

export { threadLastActivityAt } from "./conversation-policy.js";

export function formatActivityAge(timestamp, { now = Date.now(), locale = "en" } = {}) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return "";
  const seconds = Math.max(0, now / 1000 - Number(timestamp));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (seconds < 60) return format.format(0, "second");
  /** @type {Array<[Intl.RelativeTimeFormatUnit, number]>} */
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
}

export function mergeConversationHistory(previous, response, { page = false } = {}) {
  const history = response.history;
  if (!history) return response.thread;
  const removed = new Set(history.removedItemIds || []),
    turns = new Map(),
    responseItemCount = (history.turns || []).reduce((count, turn) => count + (turn.items || []).length, 0),
    previousItemCount = (previous?.turns || []).reduce((count, turn) => count + (turn.items || []).length, 0),
    preserveLoadedHistory =
      !history.resetLoadedHistory &&
      history.mode === "snapshot" &&
      previous?.history?.oldestItemId &&
      history.oldestItemId &&
      previous.history.oldestItemId !== history.oldestItemId &&
      Number(history.totalItems) > responseItemCount &&
      previousItemCount > responseItemCount;
  if (history.mode !== "snapshot" || preserveLoadedHistory)
    for (const turn of previous?.turns || [])
      turns.set(turn.id, {
        ...turn,
        items: (turn.items || []).filter((item) => !removed.has(`${turn.id}:${item.id}`)),
      });
  for (const turn of history.turns || []) {
    const old = turns.get(turn.id),
      items = new Map((old?.items || []).map((item) => [item.id, item]));
    for (const item of turn.items || []) items.set(item.id, item);
    if (items.size || (turn.id && typeof turn.status === "string"))
      turns.set(turn.id, {
        ...old,
        ...turn,
        items: [...items.values()].sort((a, b) => (a.historyOrder ?? Infinity) - (b.historyOrder ?? Infinity)),
      });
  }
  // Supplement only loaded turns so bounded history pages retain their boundaries.
  for (const supplement of history.questionTurns || []) {
    const turn = turns.get(supplement.id);
    if (!turn) continue;
    const items = new Map(turn.items.map((item) => [item.id, item]));
    for (const item of supplement.items || []) items.set(item.id, { ...items.get(item.id), ...item });
    const ordered = [...items.values()];
    for (const item of supplement.items || []) {
      if (!Number.isSafeInteger(item.questionUserSequence) || item.questionUserSequence < 1) continue;
      const index = ordered.findIndex((entry) => entry.id === item.id);
      const [question] = ordered.splice(index, 1);
      let userSequence = 0;
      const nextUser = ordered.findIndex(
        (entry) => entry.type === "userMessage" && ++userSequence > item.questionUserSequence,
      );
      ordered.splice(nextUser < 0 ? ordered.length : nextUser, 0, question);
    }
    turns.set(turn.id, { ...turn, items: ordered });
  }
  return {
    ...previous,
    ...response.thread,
    turns: [...turns.values()].sort((a, b) => (a.historyOrder ?? Infinity) - (b.historyOrder ?? Infinity)),
    history: {
      revision: page ? previous?.history?.revision : history.revision,
      nextCursor:
        preserveLoadedHistory || history.preserveOlderPages ? previous?.history?.nextCursor : history.nextCursor,
      oldestItemId:
        preserveLoadedHistory || history.preserveOlderPages ? previous?.history?.oldestItemId : history.oldestItemId,
      totalItems: Math.max(Number(previous?.history?.totalItems) || 0, Number(history.totalItems) || 0),
    },
  };
}
