import { localizeAttribute, localizeText, setMessageHtml, setOpaqueAttribute, setOpaqueText } from "./i18n.js";

import { codexIcon } from "./codex-icons.js";

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
}) {
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
    goalDialogReturnFocus = null;
  function closeGoalDialog() {
    const dialog = $("#goalDialog");
    if (dialog?.open) dialog.close();
  }
  function openGoalDialog(threadId = state.active?.id) {
    const goal = threadId && state.goals.get(threadId),
      dialog = $("#goalDialog");
    if (!goal || !dialog) return;
    goalDialogThreadId = threadId;
    goalDialogGoalId = goal.goalId;
    goalDialogReturnFocus = document.activeElement;
    localizeText(
      $("#goalDialogStatus"),
      {
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
    $("#goalDialogObjective").setCustomValidity("");
    setOpaqueText(
      $("#goalDialogDetail"),
      [goal.detail || goal.message, goalProgressText(goal.progress)].filter(Boolean).join(" · "),
    );
    $("#goalDialogError").hidden = true;
    localizeAttribute($("#goalDialogObjective"), "aria-label", "goals.goalObjective", undefined, t);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#goalDialogObjective").focus());
  }
  async function saveGoalDialog() {
    const threadId = goalDialogThreadId,
      goalId = goalDialogGoalId,
      goal = state.goals.get(threadId),
      input = $("#goalDialogObjective"),
      objective = input.value.trim(),
      button = $("#saveGoalDialog");
    if (button.disabled || !goal || goal.goalId !== goalId) return;
    if (!objective) {
      input.setCustomValidity(t("goals.goalObjectiveCannotBeEmpty"));
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    $("#goalDialogError").hidden = true;
    button.disabled = true;
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
        setOpaqueText($("#goalDialogError"), error.message);
        $("#goalDialogError").hidden = false;
      }
    } finally {
      button.disabled = false;
      localizeText(button, "common.save", undefined, t);
    }
  }
  function syncGoalStatusSurface(threadId = state.active?.id) {
    const root = $("#goalStatus");
    if (!root) return;
    const goal = threadId && state.goals.get(threadId);
    if (!goal) {
      root.hidden = true;
      root.replaceChildren();
      root.removeAttribute("data-state");
      root.removeAttribute("data-goal-id");
      return;
    }
    const labels = {
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
      `<span class="goal-status-icon" aria-hidden="true">${codexIcon(icons[goal.status] || icons.active)}</span><span class="goal-status-copy">${escapeHtml(label)}</span>${progress ? `<span class="goal-status-progress">${escapeHtml(progress)}</span>` : ""}<button type="button" class="goal-status-toggle" aria-haspopup="dialog" aria-controls="goalDialog">${t("goals.showGoalDetails")}</button>`,
    );
    root.querySelector(".goal-status-toggle").onclick = (event) => {
      event.stopPropagation();
      openGoalDialog(threadId);
    };
    root.onclick = (event) => {
      if (
        goal.status !== "blocked" ||
        event.target.closest(".goal-status-toggle") ||
        event.target.closest(".goal-status-menu")
      )
        return;
      const existing = root.querySelector(".goal-status-menu");
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
          void submitGoalCommand(state.active, { command }).catch((error) =>
            addPersistentError(error?.message || String(error)),
          );
        };
        menu.append(button);
      }
      root.append(menu);
      menu.querySelector("button")?.focus();
    };
  }
  function applyGoalStatusEvent(method, payload = {}) {
    const threadId = typeof payload.threadId === "string" && payload.threadId ? payload.threadId : state.active?.id;
    if (!threadId) return;
    const existing = state.goals.get(threadId),
      source = goalPayload(payload),
      goalId = String(source.goalId || source.id || existing?.goalId || "default"),
      updatedAt = (timestampSeconds(source.updatedAt ?? source.timestamp) || 0) * 1000;
    if (existing && existing.goalId !== goalId) return;
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
    state.goals.set(threadId, next);
    if (threadId === state.active?.id) syncGoalStatusSurface(threadId);
  }
  $("#closeGoalDialog").onclick = closeGoalDialog;
  $("#cancelGoalDialog").onclick = closeGoalDialog;
  $("#goalDialogObjective").oninput = () => $("#goalDialogObjective").setCustomValidity("");
  $("#goalDialog").addEventListener("close", () => {
    goalDialogThreadId = "";
    goalDialogGoalId = "";
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
    state.goals.delete(threadId);
    if (threadId === goalDialogThreadId) closeGoalDialog();
    syncGoalStatusSurface();
  }
  function syncGoalDialogSession() {
    if ($("#goalDialog").open && goalDialogThreadId !== state.active?.id) closeGoalDialog();
  }
  return {
    closeGoalDialog,
    openGoalDialog,
    syncGoalStatusSurface,
    applyGoalStatusEvent,
    clearGoal,
    syncGoalDialogSession,
  };
}
