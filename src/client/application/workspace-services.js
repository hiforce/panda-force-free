import { createProjectCatalog } from "../project-catalog.js";
import { takeStartupRead } from "../startup-reads.js";
import { createThreadSidebar } from "../threads-sidebar.js";
import { createWorkbench } from "../workbench.js";
import { request as fetch } from "./../http-client.js";
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "state" | "mutations", never, "projects">} options */
export function assembleProjects({ viewUpdates, state, mutations }) {
  const businessProjects = createProjectCatalog({
    onChange: () =>
      queueMicrotask(() => {
        viewUpdates.request("sidebar");
        viewUpdates.request("workbench");
      }),
    state,
  });
  return {
    businessProjects,
  };
}
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "state" | "mutations" | "sessions" | "$" | "t" | "escapeHtml" | "shortPath" | "titleOf" | "workspacePreparation", "transport" | "projects" | "repositories" | "navigation" | "workbench" | "workspace" | "sidebarLayout" | "status" | "commands" | "notices" | "synchronization", "sidebar">} options */
export function assembleSidebar({
  transportPort,
  viewUpdates,
  mutations,
  sessions,
  $,
  t,
  escapeHtml,
  shortPath,
  titleOf,
  workspacePreparation,
  projectsPort,
  repositoriesPort,
  navigationPort,
  workbenchPort,
  workspacePort,
  sidebarLayoutPort,
  statusPort,
  commandsPort,
  noticesPort,
  synchronizationPort,
  state,
}) {
  const {
    dispose,
    renderThreads,
    applyProjectVisibility,
    loadProjectVisibility: loadProjectVisibilityRaw,
    setProjectHidden,
    toggleProjectPinned,
    isProjectPinned,
  } = createThreadSidebar({
    sessions,
    $,
    t,
    projectCatalog: projectsPort.businessProjects,
    onProjectNewSession: (projectId) => navigationPort.startNewTask({ projectId }),
    onSessionProject: (id) => workbenchPort.workbench?.associateSession(id),
    initialVisibility: repositoriesPort.cachedSidebar?.visibility,
    onRender: () => viewUpdates.request("workbench"),
    onVisibility: (snapshot) => repositoriesPort.sidebarCache.saveVisibility(snapshot),
    readVisibility: () =>
      takeStartupRead("visibility", async () => {
        const response = await fetch("/api/projects/visibility", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(t("errors.couldNotLoadProjects"));
        return response.json();
      }),
    rpc: (method, params) => transportPort.rpc(method, params),
    escapeHtml: (value) => escapeHtml(value),
    shortPath: (path) => shortPath(path),
    titleOf: (thread) => titleOf(thread),
    openThread: (id) => navigationPort.openThread(id),
    startNewTask: () => navigationPort.startNewTask(),
    setWorkspace: (path) => workspacePort.setWorkspace(path),
    setProjectless: () => workspacePort.setProjectless(),
    chooseProject: (path) => workspacePort.selectWorkbenchProject(path),
    chooseProjectless: () => workspacePort.useProjectless(),
    mobileSidebarEnabled: () => sidebarLayoutPort.mobileSidebarEnabled(),
    setSidebarOpen: (open) => sidebarLayoutPort.setSidebarOpen(open),
    updateThreadRowMeta: (row, thread, meta) => statusPort.updateThreadRowMeta(row, thread, meta),
    submitNativeSlashCommand: (thread, command) => commandsPort.submitNativeSlashCommand(thread, command),
    toast: /** @param {Parameters<typeof noticesPort.toast>} args */ (...args) => noticesPort.toast(...args),
    toastProject: () => noticesPort.getToastProject(),
    dismissToast: () => noticesPort.dismissToast(),
    addPersistentError: (message) => noticesPort.addPersistentError(message),
    refreshThreadList: () => synchronizationPort.refreshThreadList(),
    cleanupDeletedThread: (threadId) => {
      repositoriesPort.evictConversationMemory(threadId);
      mutations.collection("goals").delete(threadId);
      statusPort.sessionRuntime.remove(threadId);
    },
    removeCachedConversation: (threadId) => {
      repositoriesPort.sidebarCache.remove(threadId);
      return repositoriesPort.conversations.remove(threadId);
    },
    state,
  });
  function loadProjectVisibility() {
    return workspacePreparation.track(
      "projects",
      Promise.all([loadProjectVisibilityRaw(), projectsPort.businessProjects.load()]),
    );
  }
  function bind() {
    $("#threadSearch").addEventListener(
      "input",
      /** @param {Parameters<typeof renderThreads>} args */ (...args) => renderThreads(...args),
    );
  }
  return {
    dispose,
    bind,
    setProjectHidden,
    toggleProjectPinned,
    isProjectPinned,
    renderThreads,
    loadProjectVisibility,
    loadProjectVisibilityRaw,
    applyProjectVisibility,
  };
}
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "t" | "i18n" | "workspacePreparation", "navigation" | "workspace" | "settings" | "projects" | "sidebar" | "status" | "approvals" | "sidebarLayout" | "panels", "workbench">} options */
export function assembleWorkbench({
  t,
  i18n,
  workspacePreparation,
  navigationPort,
  workspacePort,
  settingsPort,
  projectsPort,
  sidebarPort,
  statusPort,
  approvalsPort,
  sidebarLayoutPort,
  panelsPort,
  state,
  mutations,
}) {
  let workbench;
  workbench = createWorkbench({
    t,
    i18n,
    preparation: workspacePreparation,
    openThread: /** @param {Parameters<typeof navigationPort.openThread>} args */ (...args) =>
      navigationPort.openThread(...args),
    newTask: /** @param {Parameters<typeof navigationPort.startNewTask>} args */ (...args) =>
      navigationPort.startNewTask(...args),
    chooseFolder: /** @param {Parameters<typeof workspacePort.openFolderPicker>} args */ (...args) =>
      workspacePort.openFolderPicker(...args),
    chooseProject: /** @param {Parameters<typeof workspacePort.selectWorkbenchProject>} args */ (...args) =>
      workspacePort.selectWorkbenchProject(...args),
    setProjectless: /** @param {Parameters<typeof workspacePort.setProjectless>} args */ (...args) =>
      workspacePort.setProjectless(...args),
    showSettings: /** @param {Parameters<typeof settingsPort.openSettings>} args */ (...args) =>
      settingsPort.openSettings(...args),
    catalog: projectsPort.businessProjects,
    setProjectHidden: /** @param {Parameters<typeof sidebarPort.setProjectHidden>} args */ (...args) =>
      sidebarPort.setProjectHidden(...args),
    toggleProjectPinned: /** @param {Parameters<typeof sidebarPort.toggleProjectPinned>} args */ (...args) =>
      sidebarPort.toggleProjectPinned(...args),
    isProjectPinned: /** @param {Parameters<typeof sidebarPort.isProjectPinned>} args */ (...args) =>
      sidebarPort.isProjectPinned(...args),
    taskStatus: /** @param {Parameters<typeof statusPort.deriveSessionStatus>} args */ (...args) =>
      statusPort.deriveSessionStatus(...args),
    hasPendingApproval: /** @param {Parameters<typeof approvalsPort.hasPendingApproval>} args */ (...args) =>
      approvalsPort.hasPendingApproval(...args),
    closeSidebar: () => {
      if (sidebarLayoutPort.mobileSidebarEnabled()) sidebarLayoutPort.setSidebarOpen(false);
    },
    openFiles: () => panelsPort.openFilesDialog(),
    state,
  });
  return {
    get workbench() {
      return workbench;
    },
  };
}
