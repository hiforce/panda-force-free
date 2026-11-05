import { createAnchoredMenu } from "../anchored-menu.js";
import { createApprovals } from "../approvals.js";
import { createGoalController } from "../goal-controller.js";
import { createSessionControls } from "../session-controls.js";
import { createSessionRuntime } from "../session-runtime.js";
import { createSessionStatus } from "../session-status.js";
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations" | "$" | "t" | "i18n" | "titleOf" | "shortPath" | "escapeHtml", never, "status">} options */
export function assembleStatus({ viewUpdates, $, t, i18n, titleOf, shortPath, escapeHtml, state, mutations }) {
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
    runtime: sessionRuntime,
    refreshWorkbench: () => viewUpdates.request("workbench"),
    titleOf,
    shortPath,
    escapeHtml,
    onRuntimeChange: () => viewUpdates.request("composerSubmit"),
    state,
    mutations,
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
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations" | "$" | "t" | "escapeHtml", "transport" | "timing" | "notices", "goals">} options */
export function assembleGoals({
  viewUpdates,
  transportPort,
  $,
  t,
  escapeHtml,
  timingPort,
  noticesPort,
  state,
  mutations,
}) {
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
    rpc: /** @param {Parameters<typeof transportPort.rpc>} args */ (...args) => transportPort.rpc(...args),
    timestampSeconds: /** @param {Parameters<typeof timingPort.timestampSeconds>} args */ (...args) =>
      timingPort.timestampSeconds(...args),
    escapeHtml,
    submitGoalCommand,
    addPersistentError: /** @param {Parameters<typeof noticesPort.addPersistentError>} args */ (...args) =>
      noticesPort.addPersistentError(...args),
    toast: /** @param {Parameters<typeof noticesPort.toast>} args */ (...args) => noticesPort.toast(...args),
    state,
    mutations,
  });
  async function submitGoalCommand(thread, command) {
    if (!thread?.id) {
      noticesPort.toast(t("workbench.startATaskFirst"));
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
    noticesPort.toast(t(command.command === "clear" ? "goals.goalCleared" : "goals.goalUpdated"));
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
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations" | "i18n" | "$" | "t" | "state" | "escapeHtml" | "shortPath", "transport" | "turnFrames" | "notices" | "activity" | "viewport" | "review" | "panels", "approvals">} options */
export function assembleApprovals({
  transportPort,
  turnFramesPort,
  viewUpdates,
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
  mutations,
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
    approvalMenuController,
    respondToEngine: (requestId, result, error) => transportPort.respondToEngine(requestId, result, error),
    addPersistentError: (message) => noticesPort.addPersistentError(message),
    escapeHtml: (value) => escapeHtml(value),
    shortPath: (path) => shortPath(path),
    belongsToActiveThread: (params) =>
      Boolean(state.active) && (!params.threadId || params.threadId === state.active?.id),
    ensureTurnTimeline: (turnId) => turnFramesPort.ensureTurnTimeline(turnId),
    ensureActivity: (turnId, root, itemId) => activityPort.ensureActivity(turnId, root, itemId),
    setApprovalWaiting: (group, itemId, waiting) => activityPort.setApprovalWaiting(group, itemId, waiting),
    scrollBottom: () => viewportPort.scrollBottom(),
    diffForTurn: (turnId) => reviewPort.diffForTurn(turnId),
    openReviewPanel: (review) => panelsPort.openReviewPanel(review),
    state,
    mutations,
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
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "$" | "t" | "escapeHtml" | "workspacePreparation", "transport" | "notices", "models">} options */
export function assembleModels({
  transportPort,
  $,
  t,
  escapeHtml,
  workspacePreparation,
  noticesPort,
  state,
  mutations,
}) {
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
    rpc: (method, params) => transportPort.rpc(method, params),
    postBridge: (path, payload, signal) => transportPort.postBridge(path, payload, signal),
    escapeHtml: (value) => escapeHtml(value),
    toast: /** @param {Parameters<typeof noticesPort.toast>} args */ (...args) => noticesPort.toast(...args),
    addPersistentError: (message) => noticesPort.addPersistentError(message),
    state,
    mutations,
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
