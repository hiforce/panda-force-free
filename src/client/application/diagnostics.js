import { filterAppModels } from "../ui-core.js";
// Preserves the browser regression interface without adding another state store.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "stateDomains" | "state", "status" | "workbench" | "repositories" | "notifications" | "approvals" | "panels" | "synchronization" | "review" | "account" | "workspace" | "images" | "navigation" | "startup" | "sidebarLayout" | "settings" | "models" | "viewport", "diagnostics">} options */
export function assembleDiagnostics({
  viewUpdates,
  stateDomains,
  state,
  statusPort,
  workbenchPort,
  repositoriesPort,
  notificationsPort,
  approvalsPort,
  panelsPort,
  synchronizationPort,
  reviewPort,
  accountPort,
  workspacePort,
  imagesPort,
  navigationPort,
  startupPort,
  sidebarLayoutPort,
  settingsPort,
  modelsPort,
  viewportPort,
}) {
  function bind() {
    if (globalThis.__pandaForceTest !== true) {
      globalThis.__pandaForceDebug = Object.freeze({
        snapshot: () =>
          Object.freeze({
            connected: state.connected,
            activeThreadId: state.active?.id || null,
            threadCount: state.threads.length,
          }),
      });
      return;
    }
    globalThis.__pandaForceDebug = {
      sessionRuntime: statusPort.sessionRuntime,
      workbench: workbenchPort.workbench,
      persistentConversationCache: repositoriesPort.persistentConversationCache,
      notify: /** @param {Parameters<typeof notificationsPort.onNotification>} args */ (...args) =>
        notificationsPort.onNotification(...args),
      request: /** @param {Parameters<typeof approvalsPort.onServerRequest>} args */ (...args) =>
        approvalsPort.onServerRequest(...args),
      state: stateDomains.scope("diagnostics", { testing: true }).state,
      mutations: stateDomains.scope("diagnostics", { testing: true }).mutations,
      browserState: panelsPort.browserState,
      renderThreads: (...args) => viewUpdates.request("sidebar", ...args),
      applyThreadSummaries: /** @param {Parameters<typeof synchronizationPort.applyThreadSummaries>} args */ (
        ...args
      ) => synchronizationPort.applyThreadSummaries(...args),
      refreshThreadRowMetadata: /** @param {Parameters<typeof statusPort.refreshThreadRowMetadata>} args */ (...args) =>
        statusPort.refreshThreadRowMetadata(...args),
      navigateBrowser: /** @param {Parameters<typeof panelsPort.navigateBrowser>} args */ (...args) =>
        panelsPort.navigateBrowser(...args),
      renderChanges: (...args) => viewUpdates.request("review", ...args),
      renderAccount: /** @param {Parameters<typeof accountPort.renderAccount>} args */ (...args) =>
        accountPort.renderAccount(...args),
      renderHeader: (...args) => viewUpdates.request("header", ...args),
      refreshComposerPlaceholder: /** @param {Parameters<typeof workspacePort.refreshComposerPlaceholder>} args */ (
        ...args
      ) => workspacePort.refreshComposerPlaceholder(...args),
      setProjectless: /** @param {Parameters<typeof workspacePort.setProjectless>} args */ (...args) =>
        workspacePort.setProjectless(...args),
      openImageViewer: /** @param {Parameters<typeof imagesPort.openImageViewer>} args */ (...args) =>
        imagesPort.openImageViewer(...args),
      openThread: /** @param {Parameters<typeof navigationPort.openThread>} args */ (...args) =>
        navigationPort.openThread(...args),
      loadInitial: /** @param {Parameters<typeof startupPort.loadInitial>} args */ (...args) =>
        startupPort.loadInitial(...args),
      startNewTask: /** @param {Parameters<typeof navigationPort.startNewTask>} args */ (...args) =>
        navigationPort.startNewTask(...args),
      setSidebarOpen: /** @param {Parameters<typeof sidebarLayoutPort.setSidebarOpen>} args */ (...args) =>
        sidebarLayoutPort.setSidebarOpen(...args),
      openSettings: /** @param {Parameters<typeof settingsPort.openSettings>} args */ (...args) =>
        settingsPort.openSettings(...args),
      closeSettings: /** @param {Parameters<typeof settingsPort.closeSettings>} args */ (...args) =>
        settingsPort.closeSettings(...args),
      settingsRoutePage: /** @param {Parameters<typeof settingsPort.settingsRoutePage>} args */ (...args) =>
        settingsPort.settingsRoutePage(...args),
      selectedPermission: /** @param {Parameters<typeof modelsPort.selectedPermission>} args */ (...args) =>
        modelsPort.selectedPermission(...args),
      permissionThreadPolicy: /** @param {Parameters<typeof modelsPort.permissionThreadPolicy>} args */ (...args) =>
        modelsPort.permissionThreadPolicy(...args),
      permissionTurnPolicy: /** @param {Parameters<typeof modelsPort.permissionTurnPolicy>} args */ (...args) =>
        modelsPort.permissionTurnPolicy(...args),
      setPermissionMode: /** @param {Parameters<typeof modelsPort.setPermissionMode>} args */ (...args) =>
        modelsPort.setPermissionMode(...args),
      setPermissionProfiles: /** @param {Parameters<typeof modelsPort.setPermissionProfiles>} args */ (...args) =>
        modelsPort.setPermissionProfiles(...args),
      setPermissionVisibility: /** @param {Parameters<typeof modelsPort.setPermissionVisibility>} args */ (...args) =>
        modelsPort.setPermissionVisibility(...args),
      renderPermissionMenu: /** @param {Parameters<typeof modelsPort.renderPermissionMenu>} args */ (...args) =>
        modelsPort.renderPermissionMenu(...args),
      filterAppModels,
      renderModels: /** @param {Parameters<typeof modelsPort.renderModels>} args */ (...args) =>
        modelsPort.renderModels(...args),
      loadModels: /** @param {Parameters<typeof modelsPort.loadModels>} args */ (...args) =>
        modelsPort.loadModels(...args),
      syncTurnSnapshot: /** @param {Parameters<typeof synchronizationPort.syncTurnSnapshot>} args */ (...args) =>
        synchronizationPort.syncTurnSnapshot(...args),
      recordTurnReview: /** @param {Parameters<typeof reviewPort.recordTurnReview>} args */ (...args) =>
        reviewPort.recordTurnReview(...args),
      scrollOpenedThreadToBottom: /** @param {Parameters<typeof viewportPort.scrollOpenedThreadToBottom>} args */ (
        ...args
      ) => viewportPort.scrollOpenedThreadToBottom(...args),
    };
  }
  return {
    bind,
  };
}
