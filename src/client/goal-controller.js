import { errorMessage } from "./../shared/errors.js";
import { closestElement, findElement, requireElement } from "./dom.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueAttribute, setOpaqueText } from "./i18n.js";
import { codexIcon } from "./codex-icons.js";
import { createGoalLoader } from "./goals/loader.js";
// Goal dialog identity, event ordering and focus restoration stay together.
export function createGoalController({
  $,
  t,
  state,
  rpc,
  timestampSeconds,
  escapeHtml,
  submitGoalCommand,
  addPersistentError,
  toast,
  mutations,
  onChange,
  activeId = () => state.active?.id,
  readGoal = (id) => state.goals.get(id),
  isManaged = (_id) => false,
}) {
  const loader = createGoalLoader({ rpc, apply: applyGoalStatusEvent, clear: clearGoal });
  const pendingActions = new Set();
  const resumable = (goal) => goal && ["paused", "blocked"].includes(goal.status);
  function normalizeGoalStatus(value) {
    const status = String(value || "active")
      .trim()
      .toLowerCase();
    if (["complete", "completed", "succeeded", "success"].includes(status)) return "completed";
    if (["blocked", "blocking"].includes(status)) return "blocked";
    if (["usage_limited", "usagelimited"].includes(status)) return "usage_limited";
    if (["budget_limited", "budgetlimited"].includes(status)) return "budget_limited";
    if (["paused", "pause"].includes(status)) return "paused";
    if (["failed", "failure", "error", "errored"].includes(status)) return "failed";
    return "active";
  }
  function goalPayload(payload = {}) {
    const nested = payload.goal && typeof payload.goal === "object" ? payload.goal : {};
    return { ...nested, ...payload };
  }
  function goalProgressText(progress) {
    if (!progress || typeof progress !== "object") return "";
    const completed = Number(progress.completed),
      total = Number(progress.total),
      percent = Number(progress.percent);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) return `${Math.max(0, completed)}/${total}`;
    if (Number.isFinite(percent)) return `${Math.max(0, Math.min(100, percent))}%`;
    return "";
  }
  let goalDialogThreadId = "",
    goalDialogGoalId = "",
    goalDialogReturnFocus = null,
    goalDialogDraft = null;
  function closeGoalDialog() {
    const dialog = $("#goalDialog");
    if (dialog?.open) dialog.close();
  }
  const dialogGoal = (id) => readGoal(id) || (goalDialogThreadId === id ? goalDialogDraft : null);
  function syncGoalActions() {
    const threadId = goalDialogThreadId,
      goal = threadId && dialogGoal(threadId),
      button = $("#resumeGoalDialog");
    button.hidden = !resumable(goal);
    button.disabled = pendingActions.has(threadId);
    button.setAttribute("aria-busy", String(pendingActions.has(threadId)));
    $("#goalDialogPlayback").hidden = !readGoal(threadId);
    $("#pauseGoalDialog").hidden = !goal || goal.status !== "active";
    $("#pauseGoalDialog").disabled = pendingActions.has(threadId);
    $("#clearGoalDialog").disabled = pendingActions.has(threadId);
    if (isManaged(threadId) && goal)
      localizeText(
        $("#goalDialogStatus"),
        {
          draft: "creation.createGoal",
          active: "common.goalInProgress",
          paused: "common.goalPaused",
          blocked: "common.goalBlocked",
          completed: "common.goalCompleted",
        }[goal.status] || "common.goalInProgress",
        undefined,
        t,
      );
  }
  async function resumeGoal(threadId) {
    const thread = state.active,
      goal = readGoal(threadId);
    if (activeId() !== threadId || !resumable(goal) || pendingActions.has(threadId)) return;
    pendingActions.add(threadId);
    if (goalDialogThreadId === threadId) $("#goalDialogError").hidden = true;
    syncGoalActions();
    const button = findElement("button.goal-status-resume", $("#goalStatus"));
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      await submitGoalCommand(thread, { command: "resume" }, { preserveDraft: true });
    } catch (error) {
      if (goalDialogThreadId === threadId) {
        setOpaqueText($("#goalDialogError"), errorMessage(error));
        $("#goalDialogError").hidden = false;
      } else addPersistentError(errorMessage(error));
    } finally {
      pendingActions.delete(threadId);
      syncGoalActions();
      if (button?.isConnected) {
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
      }
    }
  }
  function openGoalDialog(
    threadId = activeId(),
    draft = /** @type {import("../shared/engine/types.js").Goal | null} */ (null),
  ) {
    const goal = threadId && (readGoal(threadId) || (isManaged(threadId) ? draft : null)),
      dialog = $("#goalDialog");
    if (!goal || !dialog) return;
    goalDialogThreadId = threadId;
    goalDialogGoalId = goal.goalId;
    goalDialogDraft = draft;
    goalDialogReturnFocus = document.activeElement;
    localizeText(
      $("#goalDialogStatus"),
      {
        draft: "creation.createGoal",
        active: "common.goalInProgress",
        paused: "common.goalPaused",
        blocked: "common.goalBlocked",
        usage_limited: "common.goalUsageLimited",
        budget_limited: "common.goalBudgetLimited",
        completed: "common.goalCompleted",
        failed: "common.goalFailed",
      }[goal.status] || "common.goalInProgress",
      undefined,
      t,
    );
    $("#goalDialogObjective").value = goal.objective || "";
    $("#goalDialogObjective").maxLength = isManaged(threadId) ? 16000 : 4000;
    $("#goalDialogObjective").setCustomValidity("");
    setOpaqueText(
      $("#goalDialogDetail"),
      [goal.detail || goal.message, goalProgressText(goal.progress)].filter(Boolean).join(" · "),
    );
    $("#goalDialogError").hidden = true;
    syncGoalActions();
    localizeAttribute($("#goalDialogObjective"), "aria-label", "goals.goalObjective", undefined, t);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#goalDialogObjective").focus());
  }
  async function saveGoalDialog() {
    const threadId = goalDialogThreadId,
      goalId = goalDialogGoalId,
      goal = dialogGoal(threadId),
      input = $("#goalDialogObjective"),
      objective = input.value.trim(),
      button = $("#saveGoalDialog");
    if (button.disabled || pendingActions.has(threadId) || !goal || goal.goalId !== goalId) return;
    if (!objective) {
      input.setCustomValidity(t("goals.goalObjectiveCannotBeEmpty"));
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    $("#goalDialogError").hidden = true;
    button.disabled = true;
    pendingActions.add(threadId);
    syncGoalActions();
    localizeText(button, "goals.saving", undefined, t);
    try {
      const result = await rpc("thread/goal/set", {
        threadId,
        objective,
        origin: "user",
      });
      if (result?.goal)
        applyGoalStatusEvent("thread/goal/updated", {
          threadId,
          goal: result.goal,
        });
      if (goalDialogThreadId === threadId && goalDialogGoalId === goalId) closeGoalDialog();
      toast(t("goals.goalUpdated"));
    } catch (error) {
      if (goalDialogThreadId === threadId) {
        setOpaqueText($("#goalDialogError"), errorMessage(error));
        $("#goalDialogError").hidden = false;
      }
    } finally {
      pendingActions.delete(threadId);
      syncGoalActions();
      button.disabled = false;
      localizeText(button, "common.save", undefined, t);
    }
  }
  function syncGoalStatusSurface(threadId = activeId()) {
    if (isManaged(activeId())) threadId = activeId();
    const root = $("#goalStatus");
    if (!root) return;
    const goal = threadId && readGoal(threadId);
    if (!goal) {
      root.hidden = true;
      root.replaceChildren();
      root.removeAttribute("data-state");
      root.removeAttribute("data-goal-id");
      return;
    }
    const labels = {
        draft: "creation.createGoal",
        active: "common.goalInProgress",
        paused: "common.goalPaused",
        blocked: "common.goalBlocked",
        usage_limited: "common.goalUsageLimited",
        budget_limited: "common.goalBudgetLimited",
        completed: "common.goalCompleted",
        failed: "common.goalFailed",
      },
      icons = {
        active: "loaderCircle",
        paused: "pause",
        blocked: "triangleAlert",
        usage_limited: "triangleAlert",
        budget_limited: "triangleAlert",
        completed: "check",
        failed: "triangleAlert",
      },
      label = t(labels[goal.status] || labels.active),
      progress = goalProgressText(goal.progress);
    root.hidden = false;
    root.dataset.state = goal.status;
    root.dataset.goalId = goal.goalId;
    root.setAttribute("aria-label", `${t("goals.goalStatus")}: ${label}${progress ? ` — ${progress}` : ""}`);
    setOpaqueAttribute(root, "title", `${label}${progress ? ` · ${progress}` : ""}`);
    setMessageHtml(
      root,
      `<span class="goal-status-icon" aria-hidden="true">${codexIcon(icons[goal.status] || icons.active)}</span><span class="goal-status-copy">${escapeHtml(label)}</span>${progress ? `<span class="goal-status-progress">${escapeHtml(progress)}</span>` : ""}${resumable(goal) ? `<button type="button" class="goal-status-resume" aria-label="${escapeHtml(t("common.resumeGoal"))}" title="${escapeHtml(t("common.resumeGoal"))}" ${pendingActions.has(threadId) ? 'disabled aria-busy="true"' : ""}>${codexIcon("play")}</button>` : ""}<button type="button" class="goal-status-toggle" aria-haspopup="dialog" aria-controls="goalDialog">${t("goals.showGoalDetails")}</button>`,
    );
    const resume = findElement(".goal-status-resume", root);
    if (resume)
      resume.onclick = (event) => {
        event.stopPropagation();
        void resumeGoal(threadId);
      };
    requireElement(".goal-status-toggle", root).onclick = (event) => {
      event.stopPropagation();
      openGoalDialog(threadId);
    };
    root.onclick = (event) => {
      if (
        !resumable(goal) ||
        closestElement(".goal-status-toggle", event.target) ||
        closestElement(".goal-status-menu", event.target)
      )
        return;
      const existing = findElement(".goal-status-menu", root);
      if (existing) {
        existing.remove();
        return;
      }
      const menu = document.createElement("div");
      menu.className = "goal-status-menu";
      menu.setAttribute("role", "menu");
      localizeAttribute(menu, "aria-label", "goals.goalActions", undefined, t);
      for (const [command, labelKey] of [
        ["resume", "Resume goal"],
        ["clear", "Clear goal"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        localizeText(button, labelKey, undefined, t);
        button.onclick = () => {
          menu.remove();
          void submitGoalCommand(state.active, { command }, { preserveDraft: true }).catch((error) =>
            addPersistentError(error?.message || String(error)),
          );
        };
        menu.append(button);
      }
      root.append(menu);
      findElement("button", menu)?.focus();
    };
  }
  function applyGoalStatusEvent(method, payload = {}) {
    const threadId = typeof payload.threadId === "string" && payload.threadId ? payload.threadId : state.active?.id;
    if (!threadId) return;
    if (isManaged(threadId)) {
      if (threadId === activeId()) onChange(threadId);
      return;
    }
    const existing = readGoal(threadId),
      source = goalPayload(payload),
      goalId = String(source.goalId || source.id || existing?.goalId || "default"),
      updatedAt = (timestampSeconds(source.updatedAt ?? source.timestamp) || 0) * 1000;
    if (existing && existing.goalId !== "default" && existing.goalId !== goalId) return;
    if (existing && updatedAt && existing.updatedAt && updatedAt < existing.updatedAt) return;
    const next = {
      ...(existing || {}),
      threadId,
      goalId,
      status: existing?.status || "active",
      updatedAt: updatedAt || existing?.updatedAt || Date.now(),
    };
    if (method === "goal/status/changed" || method === "thread/goal/updated" || source.status !== undefined)
      next.status = normalizeGoalStatus(source.status?.type || source.status);
    if (source.objective !== undefined) next.objective = String(source.objective || "").trim();
    if (source.detail !== undefined) next.detail = String(source.detail || "").trim();
    if (source.message !== undefined) next.message = String(source.message || "").trim();
    if (source.progress && typeof source.progress === "object") next.progress = source.progress;
    mutations.collection("goals").set(threadId, next);
    loader.changed(threadId);
    if (goalDialogThreadId === threadId) {
      if (goalDialogGoalId === "default") goalDialogGoalId = goalId;
      localizeText(
        $("#goalDialogStatus"),
        {
          draft: "creation.createGoal",
          active: "common.goalInProgress",
          paused: "common.goalPaused",
          blocked: "common.goalBlocked",
          usage_limited: "common.goalUsageLimited",
          budget_limited: "common.goalBudgetLimited",
          completed: "common.goalCompleted",
          failed: "common.goalFailed",
        }[next.status] || "common.goalInProgress",
        undefined,
        t,
      );
      syncGoalActions();
    }
    if (threadId === state.active?.id) onChange(threadId);
  }
  $("#resumeGoalDialog").onclick = () => void resumeGoal(goalDialogThreadId);
  async function changeGoal(command) {
    const threadId = goalDialogThreadId;
    if (!threadId || activeId() !== threadId || pendingActions.has(threadId)) return;
    pendingActions.add(threadId);
    syncGoalActions();
    $("#goalDialogError").hidden = true;
    try {
      await submitGoalCommand(state.active, { command }, { preserveDraft: true });
      if (command === "clear" && goalDialogThreadId === threadId) closeGoalDialog();
      else if (goalDialogThreadId === threadId) {
        localizeText($("#goalDialogStatus"), "common.goalPaused", undefined, t);
      }
    } catch (error) {
      if (goalDialogThreadId === threadId) {
        setOpaqueText($("#goalDialogError"), errorMessage(error));
        $("#goalDialogError").hidden = false;
      }
    } finally {
      pendingActions.delete(threadId);
      syncGoalActions();
    }
  }
  $("#pauseGoalDialog").onclick = () => void changeGoal("pause");
  $("#clearGoalDialog").onclick = () => void changeGoal("clear");
  $("#closeGoalDialog").onclick = closeGoalDialog;
  $("#cancelGoalDialog").onclick = closeGoalDialog;
  $("#goalDialogObjective").oninput = () => $("#goalDialogObjective").setCustomValidity("");
  $("#goalDialog").addEventListener("close", () => {
    goalDialogThreadId = "";
    goalDialogGoalId = "";
    goalDialogDraft = null;
    if (goalDialogReturnFocus?.isConnected) goalDialogReturnFocus.focus();
    goalDialogReturnFocus = null;
  });
  $("#goalDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)
        closeGoalDialog();
    }
  });
  $("#goalDialog").onsubmit = (event) => {
    event.preventDefault();
    saveGoalDialog();
  };
  function clearGoal(threadId) {
    loader.changed(threadId);
    if (!isManaged(threadId)) mutations.collection("goals").delete(threadId);
    if (threadId === goalDialogThreadId) closeGoalDialog();
    onChange(activeId());
  }
  function syncGoalDialogSession() {
    if ($("#goalDialog").open && goalDialogThreadId !== activeId()) closeGoalDialog();
  }
  return {
    closeGoalDialog,
    openGoalDialog,
    syncGoalStatusSurface,
    applyGoalStatusEvent,
    clearGoal,
    syncGoalDialogSession,
    loadGoal: (threadId) => loader.load(threadId),
  };
}
