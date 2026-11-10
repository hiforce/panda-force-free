import { setOpaqueText } from "../i18n.js";
import { findElement } from "./../dom.js";

// Interprets native lifecycle events and routes them to their owning features.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "sessions" | "state" | "$", "messages" | "models" | "status" | "notices" | "queue" | "timing" | "goals" | "approvals" | "synchronization" | "usage" | "account" | "composer" | "viewport" | "review", "notifications">} options */
export function assembleNotifications({
  viewUpdates,
  mutations,
  sessions,
  state,
  $,
  messagesPort,
  modelsPort,
  statusPort,
  noticesPort,
  queuePort,
  timingPort,
  goalsPort,
  approvalsPort,
  synchronizationPort,
  usagePort,
  accountPort,
  composerPort,
  viewportPort,
  reviewPort,
}) {
  function applyTerminalInteraction(p) {
    const itemId = String(p.itemId),
      current = state.activityItems.get(p.turnId)?.get(itemId);
    if (current?.type !== "commandExecution") return;
    let buffer = current.terminalInputBuffer || "",
      commands = [];
    for (const char of String(p.stdin || "")) {
      if (char === "\r" || char === "\n") {
        const command = buffer.trim();
        if (command) commands.push(command);
        buffer = "";
        continue;
      }
      if (char === "\u0003") {
        buffer = "";
        continue;
      }
      if (char === "\b" || char === "\u007f") {
        buffer = buffer.slice(0, -1);
        continue;
      }
      buffer += char;
    }
    const actions = [...(current.commandActions || []), ...commands.map((command) => ({ type: "unknown", command }))];
    messagesPort.upsertItem(
      { ...current, status: "inProgress", terminalInputBuffer: buffer, commandActions: actions },
      p.turnId,
    );
  }
  function belongsToActiveThread(p) {
    return Boolean(state.active) && (!p.threadId || p.threadId === state.active?.id);
  }
  function onNotification(method, p) {
    if (method === "thread/queue/changed") {
      queuePort.refreshMessageQueue(p.threadId);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && p.item?.type === "userMessage") {
      const threadId = p.threadId || state.active?.id;
      queuePort.settleQueuedMessage(p.item, p.turnId, p.threadId);
      modelsPort.commitSessionModelSettings(threadId);
    }
    // A notification without an explicit thread id is not safe to attribute to
    // the currently selected session. It may be a bridge or account-level
    // failure, so only explicit thread ids get a session error surface.
    const eventThreadId = typeof p.threadId === "string" && p.threadId ? p.threadId : null;
    const activityThreadId = eventThreadId || state.active?.id;
    if (method === "turn/started") {
      timingPort.recordTurnTiming(
        p.turn?.id,
        p.turn ? { ...p.turn, startedAt: p.turn.startedAt ?? p.pandaReceivedAt } : { startedAt: p.pandaReceivedAt },
      );
      statusPort.clearThreadError(activityThreadId);
      statusPort.updateThreadListActivity(activityThreadId, {
        status: { type: "active" },
        turnId: p.turn?.id,
        turnStatus: "inProgress",
        timestamp: Date.now() / 1000,
      });
    } else if (method === "turn/completed") {
      timingPort.recordTurnTiming(p.turn?.id, p.turn || {});
      statusPort.updateThreadListActivity(activityThreadId, {
        status: { type: "idle" },
        turnId: p.turn?.id,
        turnStatus: p.turn?.status || "completed",
        completed: true,
        timestamp: Date.now() / 1000,
      });
      if (
        eventThreadId &&
        statusPort.sessionRuntime.acceptsTurn(eventThreadId, p.turn?.id) &&
        (p.turn?.status === "failed" || p.turn?.status === "error" || p.turn?.error || p.turn?.failure)
      )
        statusPort.rememberThreadError(eventThreadId, p.turn?.error || p.turn?.failure || p.turn?.status, p.turn?.id);
      else if (
        eventThreadId &&
        statusPort.sessionRuntime.acceptsTurn(eventThreadId, p.turn?.id) &&
        p.turn?.status === "completed"
      )
        statusPort.clearThreadError(eventThreadId);
    } else if (method === "thread/status/changed") {
      if (p.status?.type === "active") statusPort.clearThreadError(p.threadId);
      statusPort.updateThreadListActivity(p.threadId, { status: p.status });
    } else if (method === "thread/settings/updated")
      modelsPort.applySessionSettings(p.threadId, p.threadSettings || p.settings || p);
    else if (method.startsWith("item/"))
      statusPort.updateThreadListActivity(activityThreadId, {
        timestamp: Date.now() / 1000,
      });
    if (method === "thread/status/changed" && statusPort.errorStatus(p.status))
      statusPort.rememberThreadError(p.threadId, p.status?.error || p.status?.failure || p.status);
    if (method === "error" && eventThreadId) {
      const failure = p.error || p.message || p;
      statusPort.rememberThreadError(eventThreadId, failure);
    }
    if (method === "thread/goal/cleared") {
      goalsPort.clearGoal(p.threadId);
      return;
    }
    if (method === "goal/status/changed" || method === "goal/progress" || method === "thread/goal/updated") {
      goalsPort.applyGoalStatusEvent(method, p);
      return;
    }
    if (method === "serverRequest/resolved") {
      approvalsPort.resolveServerRequest(p.requestId);
      return;
    }
    if (
      (method.startsWith("item/") || method.startsWith("turn/") || (method === "error" && p.threadId)) &&
      !belongsToActiveThread(p)
    ) {
      if (method === "turn/completed") {
        modelsPort.maybeNotifyTaskCompleted(p);
        synchronizationPort.refreshThreadsSoon();
      }
      return;
    }
    if (method === "account/updated") {
      usagePort.resetUsage();
      accountPort.loadAccount(true);
      if (usagePort.usagePageVisible()) usagePort.loadUsage();
    }
    if (method === "account/rateLimits/updated") {
      usagePort.applyPushedUsageLimits(p);
    } else if (method === "thread/started") {
      statusPort.clearThreadError(p.thread.id);
      sessions.upsertSummary(p.thread);
      viewUpdates.request("sidebar");
    } else if (method === "thread/name/updated") {
      const name = p.threadName || p.name;
      const t = state.threads.find((x) => x.id === p.threadId);
      if (t) sessions.upsertSummary({ id: t.id, name });
      if (state.active?.id === p.threadId) mutations.edit("active", (record) => (record.name = name));
      viewUpdates.request("sidebar");
      viewUpdates.request("header");
      if (!$("#summaryPanel").hidden) viewUpdates.request("details");
    } else if (method === "turn/started") {
      if (!p.threadId || p.threadId === state.active?.id) composerPort.setActiveTurnId(p.turn?.id || "");
      synchronizationPort.scheduleActiveThreadSync(0);
    } else if (method === "item/started") messagesPort.upsertItem({ ...p.item, status: "inProgress" }, p.turnId);
    else if (method === "item/completed") {
      const status = ["failed", "declined", "interrupted", "cancelled", "canceled"].includes(p.item?.status)
        ? p.item.status
        : "completed";
      messagesPort.upsertItem(
        {
          ...p.item,
          status,
          ...(p.item?.type === "agentMessage" ? { receivedAt: p.pandaReceivedAt } : {}),
        },
        p.turnId,
      );
    } else if (method === "item/agentMessage/delta") {
      messagesPort.appendAssistantDelta(p);
    } else if (method === "item/reasoning/summaryPartAdded") upsertReasoningDelta(p, null);
    else if (method === "item/reasoning/summaryTextDelta") upsertReasoningDelta(p, "summary");
    else if (method === "item/reasoning/textDelta") upsertReasoningDelta(p, "content");
    else if (method === "item/commandExecution/outputDelta") {
      const turn = state.turns.get(p.turnId),
        row = findElement(`[data-item-id="${CSS.escape(p.itemId)}"]`, turn),
        item = state.activityItems.get(p.turnId)?.get(String(p.itemId));
      if (item)
        messagesPort.upsertItem(
          { ...item, aggregatedOutput: (item.aggregatedOutput || "") + (p.delta || "") },
          p.turnId,
        );
      else if (row) {
        const target = findElement(".command-shell-output pre", row.nextElementSibling) || row.nextElementSibling;
        if (!target) return;
        setOpaqueText(target, (target.classList.contains("empty") ? "" : target.textContent || "") + (p.delta || ""));
        target.classList.remove("empty");
      }
    } else if (method === "item/commandExecution/terminalInteraction") applyTerminalInteraction(p);
    else if (method === "item/fileChange/outputDelta") {
      const itemId = String(p.itemId),
        current = state.activityItems.get(p.turnId)?.get(itemId),
        item =
          current?.type === "fileChange"
            ? { ...current, status: "inProgress" }
            : {
                id: itemId,
                type: "fileChange",
                status: "inProgress",
                changes: [],
              };
      item.aggregatedOutput = (item.aggregatedOutput || "") + (p.delta || "");
      messagesPort.upsertItem(item, p.turnId);
    } else if (method === "item/fileChange/patchUpdated") {
      const itemId = String(p.itemId),
        current = state.activityItems.get(p.turnId)?.get(itemId),
        item =
          current?.type === "fileChange"
            ? { ...current, status: "inProgress", changes: p.changes || [] }
            : {
                id: itemId,
                type: "fileChange",
                status: "inProgress",
                changes: p.changes || [],
              };
      messagesPort.upsertItem(item, p.turnId);
    } else if (method === "turn/diff/updated") {
      if (p.threadId && state.active?.id && p.threadId !== state.active.id) return;
      reviewPort.recordTurnReview(p.turnId, p.diff || "", "native");
    } else if (method === "turn/completed") {
      const completedTurn = p.turn ? { ...p.turn, completedAt: p.turn.completedAt ?? p.pandaReceivedAt } : p.turn;
      timingPort.recordTurnTiming(p.turn?.id, completedTurn || {});
      if (!eventThreadId && (p.turn?.status === "failed" || p.turn?.error))
        noticesPort.addPersistentError(p.turn?.error || "Codex turn failed", {
          key: p.turn?.id ? `turn:${p.turn.id}` : undefined,
        });
      if (
        (!p.threadId || p.threadId === state.active?.id) &&
        (!p.turn?.id || composerPort.activeTurnId() === p.turn.id)
      )
        composerPort.setActiveTurnId("");
      if (p.turn?.items)
        for (const i of p.turn.items)
          messagesPort.upsertItem(i.type === "agentMessage" ? { ...i, receivedAt: p.pandaReceivedAt } : i, p.turn.id);
      if (p.turn?.id) timingPort.syncWorkedForDivider(p.turn.id, timingPort.turnDurationMs(p.turn));
      viewUpdates.request("status");
      modelsPort.maybeNotifyTaskCompleted(p);
      synchronizationPort.scheduleActiveThreadSync(0);
      synchronizationPort.refreshThreadsSoon();
    } else if (method === "thread/tokenUsage/updated") {
      const threadId = p.threadId;
      if (typeof threadId === "string" && p.tokenUsage)
        sessions.recordTokenUsage(
          threadId,
          p.tokenUsage,
          p.pandaReceivedAt ? Date.parse(p.pandaReceivedAt) : Date.now(),
        );
      if (threadId === state.active?.id) viewUpdates.request("contextUsage");
    } else if (method === "thread/status/changed") {
      if (p.threadId === state.active?.id) {
        mutations.edit("active", (record) => (record.status = p.status));
        synchronizationPort.scheduleActiveThreadSync(0);
      }
      synchronizationPort.refreshThreadsSoon();
    } else if (method === "error" && !eventThreadId)
      noticesPort.addPersistentError(p.error || p.message || "Codex error", {
        key: p.turnId ? `turn:${p.turnId}` : p.id ? `codex:${p.id}` : undefined,
      });
  }
  function upsertReasoningDelta(p, field) {
    const itemId = String(p.itemId),
      items = state.activityItems.get(p.turnId),
      current = items?.get(itemId),
      item =
        current?.type === "reasoning"
          ? { ...current, status: "inProgress" }
          : { id: itemId, type: "reasoning", status: "inProgress", summary: [], content: [] };
    if (field) {
      const index = field === "summary" ? (p.summaryIndex ?? 0) : (p.contentIndex ?? 0),
        parts = Array.isArray(item[field]) ? [...item[field]] : [];
      while (parts.length <= index) parts.push("");
      parts[index] = (parts[index] || "") + (p.delta || "");
      item[field] = parts;
    }
    messagesPort.upsertItem(item, p.turnId);
    viewportPort.scrollBottom();
  }

  return {
    belongsToActiveThread,
    onNotification,
  };
}
