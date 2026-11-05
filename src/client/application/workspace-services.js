import { createProjectCatalog } from "../project-catalog.js";
import { takeStartupRead } from "../startup-reads.js";
import { createThreadSidebar } from "../threads-sidebar.js";
import { createWorkbench } from "../workbench.js";

export function assembleProjects({ viewUpdates, legacyState }) {
  const businessProjects = createProjectCatalog({
    state: legacyState,
    onChange: () =>
      queueMicrotask(() => {
        viewUpdates.request("sidebar");
        viewUpdates.request("workbench");
      }),
  });
  return {
    businessProjects,
  };
}

export function assembleSidebar({
  transportPort,
  viewUpdates,
  mutations,
  legacyState,
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
}) {
  const {
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
    state: legacyState,
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
        if (!response.ok) throw new Error(t("Could not load projects"));
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
    toast: (...args) => noticesPort.toast(...args),
    toastProject: () => noticesPort.toast.project,
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
  });
  function loadProjectVisibility() {
    return workspacePreparation.track(
      "projects",
      Promise.all([loadProjectVisibilityRaw(), projectsPort.businessProjects.load()]),
    );
  }
  function bind() {
    $("#threadSearch").addEventListener("input", (...args) => renderThreads(...args));
  }
  return {
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

export function assembleWorkbench({
  legacyState,
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
}) {
  let workbench;
  workbench = createWorkbench({
    state: legacyState,
    t,
    i18n,
    preparation: workspacePreparation,
    openThread: (...args) => navigationPort.openThread(...args),
    newTask: (...args) => navigationPort.startNewTask(...args),
    chooseFolder: (...args) => workspacePort.openFolderPicker(...args),
    chooseProject: (...args) => workspacePort.selectWorkbenchProject(...args),
    setProjectless: (...args) => workspacePort.setProjectless(...args),
    showSettings: (...args) => settingsPort.openSettings(...args),
    catalog: projectsPort.businessProjects,
    setProjectHidden: (...args) => sidebarPort.setProjectHidden(...args),
    toggleProjectPinned: (...args) => sidebarPort.toggleProjectPinned(...args),
    isProjectPinned: (...args) => sidebarPort.isProjectPinned(...args),
    taskStatus: (...args) => statusPort.deriveSessionStatus(...args),
    hasPendingApproval: (...args) => approvalsPort.hasPendingApproval(...args),
    closeSidebar: () => {
      if (sidebarLayoutPort.mobileSidebarEnabled()) sidebarLayoutPort.setSidebarOpen(false);
    },
    openFiles: () => panelsPort.openFilesDialog(),
  });
  return {
    get workbench() {
      return workbench;
    },
  };
}
