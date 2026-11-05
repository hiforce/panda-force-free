import { localizeAttribute, localizeText, setMessageHtml, setOpaqueAttribute, setOpaqueText } from "./i18n.js";

import { codexIcon } from "./codex-icons.js";
import { threadLastActivityAt, formatActivityAge } from "./ui-core.js";

// Sidebar rows, banners and the header render the same runtime projection.
export function createSessionStatus({
  $,
  t,
  i18n,
  state,
  runtime,
  refreshWorkbench,
  titleOf,
  shortPath,
  escapeHtml,
  onRuntimeChange,
}) {
  const workbench = { refresh: refreshWorkbench };
  const activeTurnId = () => runtime.activeTurnId(state.active);
  function errorMessage(value) {
    const message =
      typeof value === "string"
        ? value.trim()
        : value && typeof value === "object"
          ? String(
              value.message || value.error?.message || value.error || value.failure?.message || value.failure || "",
            ).trim()
          : "";
    return ["failed", "error", "errored", "systemerror"].includes(message.toLowerCase()) ? "" : message;
  }
  function errorStatus(status) {
    const type = typeof status === "string" ? status : status?.type;
    return ["error", "errored", "failed"].includes(String(type || "").toLowerCase());
  }
  function latestSessionTurnStatus(thread) {
    return runtime.latestStatus(thread, state.active?.id === thread?.id ? state.active : thread);
  }

  function sessionHasSuccessfulLatestTurn(thread) {
    return (
      !sessionHasActiveLatestTurn(thread) &&
      ["completed", "interrupted", "cancelled", "canceled"].includes(latestSessionTurnStatus(thread))
    );
  }
  function sessionHasActiveLatestTurn(thread) {
    if (!thread?.id) return false;
    const threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
    // Native activity can precede the new turn's first persisted visible item.
    if (threadStatus === "active") return true;
    const status = latestSessionTurnStatus(thread);
    if (status === "inProgress") return true;
    if (["completed", "interrupted", "cancelled", "canceled", "failed", "error", "errored"].includes(status))
      return false;
    return Boolean(runtime.activeTurnId(state.active?.id === thread.id ? state.active : thread));
  }

  function threadError(thread) {
    return sessionStatusError(thread);
  }
  function sessionStatusError(thread) {
    if (!thread?.id) return null;
    if (sessionHasActiveLatestTurn(thread) || sessionHasSuccessfulLatestTurn(thread)) return null;
    const tracked = runtime.get(thread.id)?.error,
      status = thread.status,
      turn = thread.turns?.at(-1);
    const value =
      tracked ||
      turn?.error ||
      turn?.failure ||
      thread.error ||
      thread.failure ||
      thread.lastError ||
      status?.error ||
      status?.failure ||
      (errorStatus(status) ? status : null);
    return value
      ? {
          message: errorMessage(value) || t("sessions.taskFailed"),
          turnId: tracked?.turnId || thread.lastError?.turnId,
        }
      : null;
  }
  function deriveSessionStatus(thread = state.active) {
    if (!thread?.id) return null;
    const error = sessionStatusError(thread),
      turn = thread.turns?.at(-1),
      turnStatus = latestSessionTurnStatus(thread),
      threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
    if (error)
      return {
        state: "error",
        label: t("sessions.taskFailed"),
        detail: error.message === t("sessions.taskFailed") ? "" : error.message,
        icon: "triangleAlert",
      };
    if (sessionHasActiveLatestTurn(thread))
      return {
        state: "running",
        label: t("common.inProgress"),
        detail: "",
        icon: "loaderCircle",
      };
    if (["completed", "interrupted", "cancelled", "canceled"].includes(turnStatus))
      return {
        state: "completed",
        label: turnStatus === "completed" ? t("sessions.completed") : t("sessions.stopped"),
        detail: "",
        icon: "check",
      };
    if (["failed", "error", "errored"].includes(turnStatus))
      return {
        state: "error",
        label: t("sessions.taskFailed"),
        detail: "",
        icon: "triangleAlert",
      };
    if (thread === state.active && activeTurnId())
      return {
        state: "running",
        label: t("common.inProgress"),
        detail: "",
        icon: "loaderCircle",
      };
    if (threadStatus === "active")
      return {
        state: "running",
        label: t("common.inProgress"),
        detail: "",
        icon: "loaderCircle",
      };
    if (!turn)
      return {
        state: "idle",
        label: t("sessions.notStarted"),
        detail: "",
        icon: "info",
      };
    return {
      state: "syncing",
      label: t("sessions.statusSyncing"),
      detail: "",
      icon: "loaderCircle",
    };
  }
  function syncSessionStatusSurface() {
    workbench?.refresh();
    const root = $("#sessionStatus");
    if (!root) return;
    const status = deriveSessionStatus();
    if (!status) {
      root.hidden = true;
      root.replaceChildren();
      root.removeAttribute("data-state");
      return;
    }
    root.hidden = false;
    root.dataset.state = status.state;
    root.setAttribute(
      "aria-label",
      `${t("common.sessionStatus")}: ${status.label}${status.detail ? ` — ${status.detail}` : ""}`,
    );
    setOpaqueAttribute(root, "title", status.detail || status.label);
    setMessageHtml(
      root,
      `<span class="session-status-icon" aria-hidden="true">${codexIcon(status.icon)}</span><span class="session-status-copy">${escapeHtml(status.label)}</span>${status.detail ? `<span class="session-status-detail">${escapeHtml(status.detail)}</span>` : ""}`,
    );
  }
  function rememberThreadError(threadId, value, turnId) {
    if (!threadId) return;
    const message = errorMessage(value) || t("sessions.taskFailed");
    const details = { message, turnId };
    runtime.rememberError(threadId, details);
    refreshThreadRowMetadata();
    if (state.active?.id === threadId) {
      syncSessionStatusSurface();
      syncThreadErrorSurface(threadId);
    }
  }
  function clearThreadError(threadId) {
    if (!threadId) return;
    runtime.clearError(threadId);
    for (const thread of [
      state.threads.find((item) => item.id === threadId),
      state.active?.id === threadId ? state.active : null,
    ])
      if (thread) {
        delete thread.error;
        delete thread.failure;
        delete thread.lastError;
      }
    refreshThreadRowMetadata();
    if (state.active?.id === threadId) {
      syncSessionStatusSurface();
      syncThreadErrorSurface(threadId);
    }
  }
  function syncThreadTurnError(threadId, turn) {
    if (!threadId || !turn) return;
    if (!runtime.acceptsTurn(threadId, turn.id)) return;
    if (turn.status === "inProgress") {
      clearThreadError(threadId);
      return;
    }
    if (errorStatus(turn.status) || turn.error || turn.failure)
      rememberThreadError(threadId, turn.error || turn.failure, turn.id);
    else if (turn.status === "completed") clearThreadError(threadId);
  }
  function syncThreadErrorsFromTurns(threadId, turns = []) {
    const turn = turns.at(-1);
    if (!turn || !runtime.acceptsTurn(threadId, turn.id)) return;
    if (turn.status === "inProgress") {
      clearThreadError(threadId);
      return;
    }
    if (errorStatus(turn.status) || turn.error || turn.failure)
      rememberThreadError(threadId, turn.error || turn.failure || turn.status, turn.id);
    else if (turn.status === "completed") clearThreadError(threadId);
  }
  function syncThreadErrorSurface(threadId = state.active?.id) {
    if (!threadId || threadId !== state.active?.id) return;
    const root = $("#conversation");
    if (!root) return;
    root.querySelector("[data-thread-error]")?.remove();
    const error = threadError(state.active);
    if (!error) return;
    const card = document.createElement("section");
    card.className = "thread-error-banner";
    card.dataset.threadError = "true";
    card.setAttribute("role", "alert");
    const heading = document.createElement("strong");
    localizeText(heading, "sessions.taskFailed", undefined, t);
    const message = document.createElement("p");
    setOpaqueText(message, error.message);
    card.append(heading, message);
    root.prepend(card);
  }
  function rememberSummaryErrors(threads) {
    for (const thread of threads) {
      if (sessionHasActiveLatestTurn(thread) || sessionHasSuccessfulLatestTurn(thread)) {
        runtime.clearError(thread.id);
        delete thread.error;
        delete thread.failure;
        delete thread.lastError;
        continue;
      }
      const status = thread.status;
      const value =
        thread.error ||
        thread.failure ||
        thread.lastError ||
        status?.error ||
        status?.failure ||
        (errorStatus(status) ? status : null);
      if (value)
        runtime.rememberError(thread.id, {
          message: errorMessage(value) || t("sessions.taskFailed"),
          turnId: value?.turnId,
        });
    }
  }
  function updateThreadRowMeta(row, thread, meta = row.querySelector(".thread-meta")) {
    if (!meta) return;
    const error = threadError(thread),
      running = !error && sessionHasActiveLatestTurn(thread),
      spinner = row.querySelector(".thread-running"),
      time = meta.querySelector("time"),
      timestamp = threadLastActivityAt(thread);
    row.dataset.running = String(running);
    row.dataset.error = String(Boolean(error));
    row.classList.toggle("error", Boolean(error));
    spinner.hidden = !running;
    localizeAttribute(spinner, "title", "common.inProgress", undefined, t);
    localizeAttribute(spinner, "aria-label", "common.inProgress", undefined, t);
    setOpaqueText(time, timestamp ? formatActivityAge(timestamp, { locale: i18n.locale }) : "—");
    const label = timestamp
      ? t("sessions.lastActivityTime", { time: time.textContent })
      : t("sessions.activityTimeUnavailable");
    const errorLabel = error ? t("sessions.taskFailedMessage", { message: error.message }) : "";
    setOpaqueAttribute(time, "title", errorLabel || label);
    time.setAttribute("aria-label", errorLabel || label);
    if (timestamp) time.dateTime = new Date(timestamp * 1000).toISOString();
    else time.removeAttribute("datetime");
    setOpaqueAttribute(
      row,
      "title",
      [titleOf(thread), shortPath(thread.cwd), running ? t("common.inProgress") : "", errorLabel, label]
        .filter(Boolean)
        .join(" — "),
    );
  }
  function refreshThreadRowMetadata() {
    workbench?.refresh();
    for (const row of $("#threadList").querySelectorAll(".thread-item")) {
      const thread = state.threads.find((thread) => thread.id === row.dataset.id);
      if (thread) updateThreadRowMeta(row, thread);
    }
  }
  function updateThreadListActivity(threadId, { status, turnId, turnStatus, completed = false, timestamp } = {}) {
    if (!threadId) return;
    const thread = state.active?.id === threadId ? state.active : state.threads.find((item) => item.id === threadId);
    if (
      !runtime.update(threadId, {
        status,
        turnId,
        turnStatus,
        completed,
        historyTailId: thread?.turns?.at(-1)?.id,
      })
    )
      return false;
    for (const thread of [
      state.threads.find((thread) => thread.id === threadId),
      state.active?.id === threadId ? state.active : null,
    ]) {
      if (!thread) continue;
      if (status) thread.status = status;
      if (timestamp) thread.lastActivityAt = Math.max(threadLastActivityAt(thread), timestamp);
    }
    refreshThreadRowMetadata();
    if (state.active?.id === threadId) {
      syncSessionStatusSurface();
      onRuntimeChange();
    }
    return true;
  }

  i18n?.subscribe(() => refreshThreadRowMetadata());

  return {
    errorStatus,
    sessionHasActiveLatestTurn,
    deriveSessionStatus,
    syncSessionStatusSurface,
    rememberThreadError,
    clearThreadError,
    syncThreadTurnError,
    syncThreadErrorsFromTurns,
    syncThreadErrorSurface,
    rememberSummaryErrors,
    updateThreadRowMeta,
    refreshThreadRowMetadata,
    updateThreadListActivity,
  };
}
