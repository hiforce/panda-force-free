import { filterAppModels } from "../ui-core.js";

// Preserves the browser regression interface without adding another state store.
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
      notify: (...args) => notificationsPort.onNotification(...args),
      request: (...args) => approvalsPort.onServerRequest(...args),
      state: stateDomains.scope("diagnostics", { testing: true }).legacyState,
      browserState: panelsPort.browserState,
      renderThreads: (...args) => viewUpdates.request("sidebar", ...args),
      applyThreadSummaries: (...args) => synchronizationPort.applyThreadSummaries(...args),
      refreshThreadRowMetadata: (...args) => statusPort.refreshThreadRowMetadata(...args),
      navigateBrowser: (...args) => panelsPort.navigateBrowser(...args),
      renderChanges: (...args) => viewUpdates.request("review", ...args),
      renderAccount: (...args) => accountPort.renderAccount(...args),
      renderHeader: (...args) => viewUpdates.request("header", ...args),
      refreshComposerPlaceholder: (...args) => workspacePort.refreshComposerPlaceholder(...args),
      setProjectless: (...args) => workspacePort.setProjectless(...args),
      openImageViewer: (...args) => imagesPort.openImageViewer(...args),
      openThread: (...args) => navigationPort.openThread(...args),
      loadInitial: (...args) => startupPort.loadInitial(...args),
      startNewTask: (...args) => navigationPort.startNewTask(...args),
      setSidebarOpen: (...args) => sidebarLayoutPort.setSidebarOpen(...args),
      openSettings: (...args) => settingsPort.openSettings(...args),
      closeSettings: (...args) => settingsPort.closeSettings(...args),
      settingsRoutePage: (...args) => settingsPort.settingsRoutePage(...args),
      selectedPermission: (...args) => modelsPort.selectedPermission(...args),
      permissionThreadPolicy: (...args) => modelsPort.permissionThreadPolicy(...args),
      permissionTurnPolicy: (...args) => modelsPort.permissionTurnPolicy(...args),
      setPermissionMode: (...args) => modelsPort.setPermissionMode(...args),
      setPermissionProfiles: (...args) => modelsPort.setPermissionProfiles(...args),
      setPermissionVisibility: (...args) => modelsPort.setPermissionVisibility(...args),
      renderPermissionMenu: (...args) => modelsPort.renderPermissionMenu(...args),
      filterAppModels,
      renderModels: (...args) => modelsPort.renderModels(...args),
      loadModels: (...args) => modelsPort.loadModels(...args),
      syncTurnSnapshot: (...args) => synchronizationPort.syncTurnSnapshot(...args),
      recordTurnReview: (...args) => reviewPort.recordTurnReview(...args),
      scrollOpenedThreadToBottom: (...args) => viewportPort.scrollOpenedThreadToBottom(...args),
    };
  }

  return {
    bind,
  };
}
