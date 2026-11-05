import { createSessionRuntime } from "../session-runtime.js";
import { createSessionStatus } from "../session-status.js";
import { createGoalController } from "../goal-controller.js";
import { createAnchoredMenu } from "../anchored-menu.js";
import { createApprovals } from "../approvals.js";
import { createSessionControls } from "../session-controls.js";

export function assembleStatus({ viewUpdates, legacyState, $, t, i18n, titleOf, shortPath, escapeHtml }) {
  const sessionRuntime = createSessionRuntime();
  const {
    errorStatus,
    deriveSessionStatus,
    syncSessionStatusSurface,
    rememberThreadError,
    clearThreadError,
    syncThreadErrorsFromTurns,
    syncThreadErrorSurface,
    rememberSummaryErrors,
    updateThreadRowMeta,
    refreshThreadRowMetadata,
    updateThreadListActivity,
  } = createSessionStatus({
    $,
    t,
    i18n,
    state: legacyState,
    runtime: sessionRuntime,
    refreshWorkbench: () => viewUpdates.request("workbench"),
    titleOf,
    shortPath,
    escapeHtml,
    onRuntimeChange: () => viewUpdates.request("composerSubmit"),
  });
  return {
    deriveSessionStatus,
    syncSessionStatusSurface,
    syncThreadErrorSurface,
    sessionRuntime,
    updateThreadListActivity,
    syncThreadErrorsFromTurns,
    refreshThreadRowMetadata,
    rememberSummaryErrors,
    updateThreadRowMeta,
    errorStatus,
    rememberThreadError,
    clearThreadError,
  };
}

export function assembleGoals({ viewUpdates, transportPort, legacyState, $, t, escapeHtml, timingPort, noticesPort }) {
  const {
    closeGoalDialog,
    openGoalDialog,
    syncGoalStatusSurface,
    applyGoalStatusEvent,
    clearGoal,
    syncGoalDialogSession,
  } = createGoalController({
    $,
    t,
    state: legacyState,
    rpc: (...args) => transportPort.rpc(...args),
    timestampSeconds: (...args) => timingPort.timestampSeconds(...args),
    escapeHtml,
    submitGoalCommand,
    addPersistentError: (...args) => noticesPort.addPersistentError(...args),
    toast: (...args) => noticesPort.toast(...args),
  });
  async function submitGoalCommand(thread, command) {
    if (!thread?.id) {
      noticesPort.toast(t("Start a task first"));
      return;
    }
    let result;
    if (command.command === "clear")
      result = await transportPort.rpc("thread/goal/clear", {
        threadId: thread.id,
        origin: "user",
      });
    else if (command.command === "pause" || command.command === "resume")
      result = await transportPort.rpc("thread/goal/set", {
        threadId: thread.id,
        status: command.command === "pause" ? "paused" : "active",
        origin: "user",
      });
    else if (command.objective)
      result = await transportPort.rpc("thread/goal/set", {
        threadId: thread.id,
        objective: command.objective,
        status: "active",
        origin: "user",
      });
    else {
      openGoalDialog(thread.id);
      return;
    }
    if (result?.goal)
      applyGoalStatusEvent("thread/goal/updated", {
        threadId: thread.id,
        goal: result.goal,
      });
    if (command.command === "clear") clearGoal(thread.id);
    $("#prompt").value = "";
    viewUpdates.request("composerLayout");
    viewUpdates.request("goals", thread.id);
    noticesPort.toast(t(command.command === "clear" ? "Goal cleared" : "Goal updated"));
  }
  return {
    submitGoalCommand,
    syncGoalDialogSession,
    syncGoalStatusSurface,
    closeGoalDialog,
    clearGoal,
    applyGoalStatusEvent,
    openGoalDialog,
  };
}

export function assembleApprovals({
  transportPort,
  turnFramesPort,
  viewUpdates,
  legacyState,
  i18n,
  $,
  t,
  state,
  escapeHtml,
  shortPath,
  noticesPort,
  activityPort,
  viewportPort,
  reviewPort,
  panelsPort,
}) {
  const approvalMenuController = createAnchoredMenu();
  const {
    onServerRequest,
    resolveServerRequest,
    restorePendingApprovals,
    clearApprovals,
    hasPendingApproval,
    refreshPendingApprovals,
  } = createApprovals({
    i18n,
    onPendingChange: () => viewUpdates.request("workbench"),
    $,
    t,
    state: legacyState,
    approvalMenuController,
    respondToCodex: (requestId, result, error) => transportPort.respondToCodex(requestId, result, error),
    addPersistentError: (message) => noticesPort.addPersistentError(message),
    escapeHtml: (value) => escapeHtml(value),
    shortPath: (path) => shortPath(path),
    belongsToActiveThread: (params) =>
      Boolean(state.active) && (!params.threadId || params.threadId === state.active.id),
    ensureTurnTimeline: (turnId) => turnFramesPort.ensureTurnTimeline(turnId),
    ensureActivity: (turnId, root, itemId) => activityPort.ensureActivity(turnId, root, itemId),
    setApprovalWaiting: (group, itemId, waiting) => activityPort.setApprovalWaiting(group, itemId, waiting),
    scrollBottom: () => viewportPort.scrollBottom(),
    diffForTurn: (turnId) => reviewPort.diffForTurn(turnId),
    openReviewPanel: (review) => panelsPort.openReviewPanel(review),
  });
  return {
    hasPendingApproval,
    restorePendingApprovals,
    approvalMenuController,
    refreshPendingApprovals,
    onServerRequest,
    clearApprovals,
    resolveServerRequest,
  };
}

export function assembleModels({ transportPort, legacyState, $, t, escapeHtml, workspacePreparation, noticesPort }) {
  const {
    applySessionSettings,
    closeModelMenu,
    closePermissionMenu,
    commitSessionModelSettings,
    loadModels: loadModelsRaw,
    loadPermissionProfiles: loadPermissionProfilesRaw,
    maybeNotifyTaskCompleted,
    modelDisplay,
    openModelMenu,
    permissionThreadPolicy,
    permissionTurnPolicy,
    reasoningLabel,
    renderContextUsage,
    renderModelMenuMain,
    renderModels,
    renderPermissionMenu,
    requestTaskNotifyPermission,
    selectedModel,
    selectedPermission,
    setPermissionMode,
    setPermissionProfiles,
    setPermissionVisibility,
    syncModelLabel,
    syncPermissionControl,
    syncPermissionSettings,
  } = createSessionControls({
    $,
    t,
    state: legacyState,
    rpc: (method, params) => transportPort.rpc(method, params),
    postBridge: (path, payload, signal) => transportPort.postBridge(path, payload, signal),
    escapeHtml: (value) => escapeHtml(value),
    toast: (...args) => noticesPort.toast(...args),
    addPersistentError: (message) => noticesPort.addPersistentError(message),
  });
  function loadModels(options) {
    return workspacePreparation.track("models", loadModelsRaw(options));
  }
  function loadPermissionProfiles() {
    return workspacePreparation.track("permissions", loadPermissionProfilesRaw());
  }
  return {
    loadPermissionProfiles,
    renderContextUsage,
    applySessionSettings,
    permissionThreadPolicy,
    commitSessionModelSettings,
    syncPermissionControl,
    openModelMenu,
    loadModels,
    loadModelsRaw,
    loadPermissionProfilesRaw,
    requestTaskNotifyPermission,
    modelDisplay,
    selectedModel,
    reasoningLabel,
    selectedPermission,
    syncPermissionSettings,
    maybeNotifyTaskCompleted,
    closePermissionMenu,
    permissionTurnPolicy,
    syncModelLabel,
    renderModelMenuMain,
    closeModelMenu,
    setPermissionMode,
    setPermissionProfiles,
    setPermissionVisibility,
    renderPermissionMenu,
    renderModels,
  };
}
