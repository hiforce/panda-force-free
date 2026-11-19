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
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations" | "$" | "t" | "escapeHtml", "transport" | "timing" | "notices" | "workbench", "goals">} options */
export function assembleGoals({
  viewUpdates,
  transportPort,
  $,
  t,
  escapeHtml,
  timingPort,
  workbenchPort,
  noticesPort,
  state,
  mutations,
}) {
  const creation = () => workbenchPort.workbench?.creationSession();
  const managed = (id) => typeof id === "string" && id.startsWith("creation:");
  const activeId = () => creation()?.key || state.active?.id;
  async function goalRpc(method, params) {
    if (!managed(params.threadId)) return transportPort.rpc(method, params);
    const domain = creation();
    if (!domain || domain.key !== params.threadId)
      throw new Error(t("workbench.conversationChangedReopenTheQuestionBeforeSubmitting"));
    if (method === "thread/goal/get") return { goal: domain.goal() };
    if (method === "thread/goal/clear") return { goal: await domain.goalCommand({ action: "clear" }) };
    if (method === "thread/goal/set")
      return {
        goal: await domain.goalCommand({
          action: params.objective ? "set" : params.status === "paused" ? "pause" : "resume",
          ...(params.objective ? { objective: params.objective } : {}),
        }),
      };
    throw new Error(t("creation.taskActionFailed"));
  }
  const {
    closeGoalDialog,
    openGoalDialog,
    syncGoalStatusSurface,
    applyGoalStatusEvent,
    clearGoal,
    syncGoalDialogSession,
    loadGoal,
  } = createGoalController({
    $,
    t,
    rpc: goalRpc,
    activeId,
    readGoal: (id) => {
      const domain = creation();
      return managed(id) ? (domain?.key === id ? domain?.goal() : null) : state.goals.get(id);
    },
    isManaged: managed,
    timestampSeconds: /** @param {Parameters<typeof timingPort.timestampSeconds>} args */ (...args) =>
      timingPort.timestampSeconds(...args),
    escapeHtml,
    submitGoalCommand,
    addPersistentError: /** @param {Parameters<typeof noticesPort.addPersistentError>} args */ (...args) =>
      noticesPort.addPersistentError(...args),
    toast: /** @param {Parameters<typeof noticesPort.toast>} args */ (...args) => noticesPort.toast(...args),
    state,
    mutations,
    onChange: (threadId) => viewUpdates.request("goals", threadId),
  });
  async function submitGoalCommand(thread, command, options = {}) {
    const domain = creation();
    if (domain) {
      if (command.objective || ["clear", "pause", "resume"].includes(command.command)) {
        await domain.goalCommand({
          action: command.objective ? "set" : command.command,
          ...(command.objective ? { objective: command.objective } : {}),
        });
      } else if (domain.goal()) openGoalDialog(domain.key);
      else noticesPort.toast(t("creation.createGoal"));
      viewUpdates.request("goals");
      return;
    }
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
    if (thread.id === state.active?.id) {
      if (!options.preserveDraft) {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
      }
      viewUpdates.request("goals", thread.id);
    }
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
    loadGoal,
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
    pendingInteraction,
    pendingCard,
    refreshPendingApprovals,
  } = createApprovals({
    i18n,
    onPendingChange: () => {
      viewUpdates.request("workbench");
      viewUpdates.request("sessionWorkspace");
    },
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
    pendingInteraction,
    pendingCard,
    restorePendingApprovals,
    approvalMenuController,
    refreshPendingApprovals,
    onServerRequest,
    clearApprovals,
    resolveServerRequest,
  };
}
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations" | "$" | "t" | "escapeHtml" | "workspacePreparation", "transport" | "notices", "models">} options */
export function assembleModels({
  viewUpdates,
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
    sessionControlView,
    applyModelSelection,
    applyPermissionSelection,
    applySessionSettings,
    closeModelMenu,
    closePermissionMenu,
    commitSessionModelSettings,
    loadModels: loadModelsRaw,
    loadPermissionProfiles: loadPermissionProfilesRaw,
    maybeNotifyTaskCompleted,
    modelDisplay,
    openModelMenu,
    openPermissionMenu,
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
    addPersistentError: /** @param {Parameters<typeof noticesPort.addPersistentError>} args */ (...args) =>
      noticesPort.addPersistentError(...args),
    state,
    mutations,
    onSettingsChanged: () => viewUpdates.request("sessionWorkspace"),
    onModelsLoaded: () => noticesPort.removePersistentError("model-load"),
  });
  function loadModels(options) {
    return workspacePreparation.track("models", loadModelsRaw(options));
  }
  function loadPermissionProfiles() {
    return workspacePreparation.track("permissions", loadPermissionProfilesRaw());
  }
  return {
    sessionControlView,
    applyModelSelection,
    applyPermissionSelection,
    loadPermissionProfiles,
    renderContextUsage,
    applySessionSettings,
    permissionThreadPolicy,
    commitSessionModelSettings,
    syncPermissionControl,
    openModelMenu,
    openPermissionMenu,
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
