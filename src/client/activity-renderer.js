import { getBrowserI18n, localizeText, messageHtml, setMessageHtml, setOpaqueText } from "./i18n.js";

import { codexIcon } from "./codex-icons.js";
import { storage } from "./storage.js";
import { activityText, mergeReasoningItem } from "../shared/activity-text.js";
import { summarizeActivity, parseUnifiedDiff, unifiedDiffFromFileChanges } from "../shared/codex-surfaces.js";
import { renderAssistantMarkdown, renderItemImages } from "./rendering.js";
import { renderDiffLine } from "./diff-rendering.js";

// Activity items and their expansion preferences are rendered independently of
// transport delivery. Batching prevents rebuilding a summary for every item.
export function createActivityRenderer({
  state,
  escapeHtml,
  shortPath,
  ensureTurnTimeline,
  imageCwd,
  syncWorkedForDivider,
  isRenderingTurn,
}) {
  const i18n = getBrowserI18n(),
    t = i18n.t;
  const pendingActivitySummaries = new Set();
  i18n.subscribe(() => {
    for (const activity of document.querySelectorAll("[data-agent-activity-group]")) updateActivitySummary(activity);
  });
  const reviewLineHtml = (line) => renderDiffLine(line, escapeHtml);
  const icons = {
    chevron: codexIcon("chevronRight", "activity-chevron"),
    terminal: codexIcon("terminal"),
    check: codexIcon("check"),
  };
  function activityGroupExpansionKey(activity) {
    const threadId = state.active?.id,
      turnId = activity.closest("[data-turn-id]")?.dataset.turnId,
      anchor = activity.dataset.activityGroupAnchor;
    return threadId && turnId && anchor ? `panda-force-activity-group:${threadId}:${turnId}:${anchor}` : null;
  }
  function savedActivityGroupExpansion(activity) {
    const key = activityGroupExpansionKey(activity),
      saved = key && storage.get(key);
    return saved === "open" ? true : saved === "closed" ? false : null;
  }
  function setActivityGroupOpen(activity, open, persist = false) {
    const button = activity.querySelector(".activity-summary"),
      items = activity.querySelector(".activity-items");
    button.classList.toggle("open", open);
    items.classList.toggle("open", open);
    if (persist && !activity.classList.contains("single")) {
      const key = activityGroupExpansionKey(activity);
      if (key) storage.set(key, open ? "open" : "closed");
    }
  }
  function ensureActivity(turnId, root, itemId, standalone = false) {
    const turn = ensureTurnTimeline(turnId, root),
      stream = turn.querySelector(".turn-event-stream"),
      existing = itemId
        ? turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest("[data-agent-activity-group]")
        : null;
    if (existing) return existing;
    let activity = standalone ? null : state.activities.get(turnId);
    if (
      !activity?.isConnected ||
      activity.parentElement !== stream ||
      stream.lastElementChild !== activity ||
      activity.dataset.standalone === "true"
    ) {
      activity = document.createElement("div");
      activity.className = "activity-group active";
      activity.dataset.agentActivityGroup = "";
      activity.dataset.activityGroupAnchor = String(itemId || "activity");
      if (standalone) activity.dataset.standalone = "true";
      setMessageHtml(
        activity,
        `<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer"><span data-pf-message="common.working">Working</span></span>${icons.chevron}</button><div class="activity-items open"></div>`,
      );
      activity.querySelector(".activity-summary").onclick = () =>
        setActivityGroupOpen(activity, !activity.querySelector(".activity-summary").classList.contains("open"), true);
      stream.append(activity);
      state.activities.set(turnId, activity);
    }
    if (!state.activityItems.has(turnId)) state.activityItems.set(turnId, new Map());
    return activity;
  }
  function joinActivityText(value) {
    return activityText(value);
  }
  function activityOutput(item) {
    if (item.type === "reasoning") return joinActivityText(item.summary) || joinActivityText(item.content);
    const output = item.aggregatedOutput ?? item.output?.aggregatedOutput ?? item.output;
    if (typeof output === "string") return output;
    if (Array.isArray(output)) return output.join("\n");
    return joinActivityText(item.content) || (item.result ? JSON.stringify(item.result, null, 2) : "");
  }
  function commandText(item) {
    return (
      item.command ||
      (item.commandActions || [])
        .map((action) => action?.command)
        .filter(Boolean)
        .join("\n") ||
      ""
    );
  }
  function commandExitCode(item) {
    return item.exitCode ?? item.output?.exitCode;
  }
  function commandFooter(item, data) {
    if (data.active) return { label: "", icon: "" };
    if (item.executionStatus === "interrupted" || item.status === "interrupted" || item.status === "cancelled")
      return { label: "sessions.stopped", icon: "" };
    const exitCode = commandExitCode(item);
    if (data.tone === "error")
      return {
        label: exitCode == null ? "common.failed" : "common.exitCode",
        values: { code: exitCode },
        icon: "",
      };
    return { label: "common.success", icon: icons.check };
  }
  function renderCommandShell(out, item, data) {
    if (out.dataset.outputKind !== "command") {
      out.dataset.outputKind = "command";
      out.className = "activity-output command-shell-wrap";
      setMessageHtml(
        out,
        '<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>',
      );
    }
    const output = activityOutput(item),
      pre = out.querySelector(".command-shell-output pre"),
      footer = commandFooter(item, data);
    setOpaqueText(out.querySelector(".command-shell-command code"), commandText(item));
    if (output || data.active) setOpaqueText(pre, output);
    else localizeText(pre, "common.noOutput");
    pre.classList.toggle("empty", !output);
    setMessageHtml(
      out.querySelector(".command-shell-footer"),
      `${footer.icon}${footer.label ? messageHtml(footer.label, footer.values) : ""}`,
    );
  }
  function inlineFileChangeDiff(change) {
    const raw = unifiedDiffFromFileChanges([change]),
      review = parseUnifiedDiff(raw);
    if (!review.hasChanges) {
      const diff = change.diff || change.unified_diff || "";
      return diff ? `<pre>${escapeHtml(diff)}</pre>` : "";
    }
    return `<div class="file-change-inline-diff">${review.files.flatMap((file) => file.hunks.map((hunk) => `<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join("")}</div></div>`)).join("")}</div>`;
  }
  function renderFileChangeOutput(out, item, data) {
    out.dataset.outputKind = "file-change";
    out.className = "activity-output file-change-output";
    const changes = item.changes || [],
      legacy = activityOutput(item);
    if (!changes.length) {
      setMessageHtml(
        out,
        `<div class="file-change-progress ${data.active ? "loading-shimmer" : ""}">${legacy ? escapeHtml(legacy) : messageHtml(data.active ? "common.waitingPatch" : "common.noPatchDetails")}</div>`,
      );
      return;
    }
    setMessageHtml(
      out,
      changes
        .map((change) => {
          const path = change.path || change.filePath || "Changed file",
            kind = typeof change.kind === "string" ? change.kind : change.kind?.type || "update";
          return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon("fileDiff")}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`;
        })
        .join(""),
    );
  }
  function isExplorationActivity(item, data = summarizeActivity(item)) {
    return item.type === "commandExecution" && ["read", "search", "list"].includes(data.category);
  }
  function renderActivityOutput(out, item, data) {
    if (item.type === "imageView") {
      out.dataset.outputKind = "image";
      out.className = "activity-output activity-image-output";
      setMessageHtml(
        out,
        renderItemImages(item, {
          cwd: imageCwd(item),
          className: "activity-image-grid",
          thumbnail: true,
        }) ||
          '<div class="message-image-unavailable" data-i18n-ui><span data-pf-message="common.imageUnavailable">Image unavailable</span></div>',
      );
      return;
    }
    if (item.type === "commandExecution" && data.category === "command") {
      renderCommandShell(out, item, data);
      return;
    }
    if (item.type === "fileChange") {
      renderFileChangeOutput(out, item, data);
      return;
    }
    if (item.type === "reasoning") {
      const text = activityOutput(item);
      out.dataset.outputKind = "reasoning";
      out.className = "activity-output reasoning-output message-text";
      setMessageHtml(out, text ? renderAssistantMarkdown(text, { cwd: imageCwd(item) }) : "");
      return;
    }
    out.dataset.outputKind = "plain";
    out.className = "activity-output";
    setOpaqueText(out, isExplorationActivity(item, data) ? "" : activityOutput(item) || "");
  }
  function activityItemExpansionKey(row) {
    const threadId = state.active?.id,
      turnId = row.closest("[data-turn-id]")?.dataset.turnId,
      itemId = row.dataset.itemId;
    return threadId && turnId && itemId ? `panda-force-activity-item:${threadId}:${turnId}:${itemId}` : null;
  }
  function savedActivityItemExpansion(row) {
    const key = activityItemExpansionKey(row),
      saved = key && storage.get(key);
    return saved === "open" ? true : saved === "closed" ? false : null;
  }
  function setActivityExpanded(row, expanded, persist = false) {
    row.classList.toggle("expanded", expanded);
    row.setAttribute("aria-expanded", String(expanded));
    if (persist) {
      const key = activityItemExpansionKey(row);
      if (key) storage.set(key, expanded ? "open" : "closed");
    }
  }
  function motionIcon(name) {
    return `<span class="activity-motion" data-animation="${name}"></span>`;
  }
  function mountMotion(row) {
    // Use an inspectable CSS animation rather than redistributed desktop assets.
    const holder = row.querySelector(".activity-motion");
    if (holder) setMessageHtml(holder, codexIcon("loaderCircle", "motion-fallback"));
  }

  function activityIconName(item, data = summarizeActivity(item)) {
    if (item.type === "reasoning") return null;
    if (data.tone === "error") return "triangleAlert";
    if (item.type === "fileChange") return "fileDiff";
    if (data.category === "image") return "image";
    if (data.category === "read") return "file";
    if (data.category === "search" || item.type === "webSearch") return "search";
    if (data.category === "list") return "list";
    if (data.category === "command") return "terminal";
    return "wrench";
  }
  function stopMotion(row, tone) {
    const holder = row.querySelector(".activity-motion"),
      turnId = row.closest("[data-turn-id]")?.dataset.turnId,
      item = state.activityItems.get(turnId)?.get(row.dataset.itemId),
      data = item ? summarizeActivity(item) : { tone };
    if (!holder) return;
    const icon = activityIconName(item || {}, data);
    setMessageHtml(holder, icon ? codexIcon(icon) : "");
  }
  function activityItemId(item) {
    return String(item.id || item.callId || item.requestId || `${item.type}-${Date.now()}`);
  }
  function completedActivitySummary(items) {
    const summaries = items.map((item) => ({ item, data: summarizeActivity(item) }));
    const successful = summaries.filter(({ data }) => data.tone !== "error");
    const edits = successful
      .filter(({ item }) => item.type === "fileChange")
      .reduce((n, { item }) => n + Math.max(1, item.changes?.length || 0), 0);
    const commands = summaries.filter(
      ({ item, data }) => item.type === "commandExecution" && data.category === "command",
    ).length;
    const parts = [],
      add = (key, values = {}) => parts.push(t(key, { ...values, position: parts.length ? "other" : "first" }));
    if (edits) add("common.editedCount", { count: edits });
    if (successful.some(({ data }) => ["read", "search", "list"].includes(data.category))) add("common.summaryRead");
    if (commands) add("common.ranCount", { count: commands });
    if (successful.some(({ item }) => item.type === "webSearch")) add("common.summaryWeb");
    if (successful.some(({ data }) => data.category === "image")) add("common.summaryImages");
    if (!parts.length)
      return t(summaries.some(({ data }) => data.tone === "error") ? "common.activityFailed" : "common.worked");
    return i18n.format.list(parts);
  }
  function completedActivityPrimaryItem(items) {
    const summaries = items.map((item) => ({
        item,
        data: summarizeActivity(item),
      })),
      find = (predicate) => summaries.find(predicate)?.item;
    return (
      find(({ item, data }) => item.type === "fileChange" && data.tone !== "error") ||
      find(({ data }) => ["read", "search", "list"].includes(data.category) && data.tone !== "error") ||
      find(({ data }) => data.category === "command" && data.tone !== "error") ||
      find(({ item, data }) => item.type === "webSearch" && data.tone !== "error") ||
      find(({ data }) => data.category === "image" && data.tone !== "error") ||
      items.find((item) => summarizeActivity(item).tone === "error") ||
      items[0]
    );
  }
  function setActivitySummaryIcon(activity, item) {
    const holder = activity.querySelector(".activity-summary-icon"),
      icon = item && activityIconName(item);
    if (holder) {
      holder.hidden = !icon;
      setMessageHtml(holder, icon ? codexIcon(icon) : "");
    }
  }
  function commandRowMessage(item, data, expanded) {
    if (data.active) return [data.labelKey, {}];
    const interrupted = item.executionStatus === "interrupted" || ["interrupted", "cancelled"].includes(item.status);
    const command = commandText(item);
    return expanded || !command
      ? [interrupted ? "common.stoppedCommandLabel" : "common.ranCommand", {}]
      : [interrupted ? "common.stoppedCommandWithCommand" : "common.ranCommandWithCommand", { command }];
  }
  function updateCommandRowSummary(row, item, data, expanded = row.classList.contains("expanded")) {
    const summary = row.querySelector(".activity-name");
    if (summary) localizeText(summary, ...commandRowMessage(item, data, expanded));
  }
  function updateActivitySummary(activity) {
    if (isRenderingTurn()) {
      pendingActivitySummaries.add(activity);
      return;
    }
    const turn = activity.closest("[data-turn-id]"),
      turnId = turn?.dataset.turnId,
      allItems = state.activityItems.get(turnId),
      rows = [...activity.querySelectorAll(".activity-item")].filter((row) => !row.hidden),
      items = rows.map((row) => allItems?.get(row.dataset.itemId)).filter(Boolean),
      summary = activity.querySelector(".activity-summary-copy");
    if (!turn || !summary) return;
    activity.hidden = items.length === 0;
    activity.classList.toggle("single", items.length === 1);
    const activeItem =
        items.findLast?.((item) => summarizeActivity(item).active) ||
        [...items].reverse().find((item) => summarizeActivity(item).active),
      savedOpen = savedActivityGroupExpansion(activity);
    if (activeItem) {
      const data = summarizeActivity(activeItem);
      setActivitySummaryIcon(activity, activeItem);
      localizeText(summary, data.labelKey);
      summary.classList.add("loading-shimmer");
      activity.classList.add("active");
      setActivityGroupOpen(activity, items.length === 1 || (savedOpen ?? true));
    } else {
      setActivitySummaryIcon(activity, completedActivityPrimaryItem(items));
      setOpaqueText(summary, completedActivitySummary(items));
      summary.classList.remove("loading-shimmer");
      activity.classList.remove("active");
      setActivityGroupOpen(activity, items.length === 1 || (savedOpen ?? false));
    }
    syncWorkedForDivider(turnId);
  }
  function addActivity(item, activity, id = activityItemId(item)) {
    const turn = activity.closest("[data-turn-id]"),
      turnId = turn.dataset.turnId,
      items = state.activityItems.get(turnId) || new Map(),
      box = activity.querySelector(".activity-items");
    item = mergeReasoningItem(items.get(id), item);
    const data = summarizeActivity(item);
    items.set(id, item);
    state.activityItems.set(turnId, items);
    let row = box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "activity-item entering";
      row.dataset.itemId = id;
      box.append(row);
      const out = document.createElement("div");
      out.className = "activity-output";
      box.append(out);
    }
    const imageView = item.type === "imageView",
      reasoning = item.type === "reasoning",
      command = item.type === "commandExecution" && data.category === "command",
      fileChange = item.type === "fileChange",
      wasActive = row.dataset.activityWasActive === "true",
      savedExpanded = savedActivityItemExpansion(row),
      existingExpanded = row.dataset.expansionInitialized ? row.classList.contains("expanded") : imageView,
      expanded = reasoning
        ? data.active
          ? true
          : wasActive
            ? false
            : (savedExpanded ?? existingExpanded)
        : (savedExpanded ?? existingExpanded);
    row.dataset.expansionInitialized = "true";
    row.dataset.activityWasActive = String(data.active);
    row.className = `activity-item ${command ? "command-activity " : ""}${reasoning ? "reasoning-activity " : ""}${imageView ? "image-activity " : ""}${fileChange ? "file-change-activity " : ""}${data.active ? "active" : "settled"} ${data.tone}`;
    if (command) {
      setMessageHtml(
        row,
        `<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}">${messageHtml(...commandRowMessage(item, data, expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`,
      );
    } else if (reasoning) {
      setMessageHtml(
        row,
        `<div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}">${messageHtml(data.labelKey)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`,
      );
    } else {
      const detail = shortPath(data.detail || "");
      setMessageHtml(
        row,
        `${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}"><span class="activity-label">${messageHtml(data.labelKey)}</span>${detail ? ` <span class="activity-detail">${escapeHtml(detail)}</span>` : ""}</div></div><span class="activity-result">${fileChange ? icons.chevron : ""}</span>`,
      );
    }
    const out = row.nextElementSibling;
    row.hidden = reasoning && !data.active && !activityOutput(item).trim();
    out.hidden = row.hidden;
    renderActivityOutput(out, item, data);
    const reasoningOutput = reasoning && !!activityOutput(item),
      expandable =
        imageView ||
        command ||
        fileChange ||
        (reasoning && !data.active && reasoningOutput) ||
        (!reasoning && !isExplorationActivity(item, data) && !!activityOutput(item));
    if (reasoning && data.active && reasoningOutput) {
      row.removeAttribute("role");
      row.removeAttribute("aria-expanded");
      row.tabIndex = -1;
      row.classList.add("expanded");
    } else if (expandable) {
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      setActivityExpanded(row, expanded);
    } else {
      row.removeAttribute("role");
      row.removeAttribute("aria-expanded");
      row.tabIndex = -1;
      row.classList.remove("expanded");
    }
    row.onclick = expandable
      ? () => {
          const next = !row.classList.contains("expanded");
          setActivityExpanded(row, next, true);
          if (command) updateCommandRowSummary(row, item, data, next);
        }
      : null;
    row.onkeydown = expandable
      ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            row.click();
          }
        }
      : null;
    if (!command && !reasoning) {
      if (data.active) mountMotion(row, data.animation);
      else stopMotion(row, data.tone);
    }
    updateActivitySummary(activity);
  }

  return {
    ensureActivity,
    activityItemId,
    updateActivitySummary,
    addActivity,
    flush() {
      for (const activity of pendingActivitySummaries) updateActivitySummary(activity);
      pendingActivitySummaries.clear();
    },
  };
}
