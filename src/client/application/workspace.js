import { parseWorkbenchRoute } from "../workbench-route.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { createLatestRequestGate, resolveComposerPlaceholder } from "../ui-core.js";
import { codexIcon } from "../codex-icons.js";

// Owns workspace state and operations; peers are explicit application ports.
export function assembleWorkspace({
  viewUpdates,
  mutations,
  $,
  escapeHtml,
  state,
  t,
  shortPath,
  titleOf,
  timelinePort,
  modelsPort,
  composerPort,
  navigationPort,
  projectsPort,
  goalsPort,
  queuePort,
}) {
  let folderBrowse = { path: "~", parent: null, selected: null };
  const workspaceContextRequestGate = createLatestRequestGate(),
    folderRequestGate = createLatestRequestGate();
  const icons = { file: codexIcon("file") };
  async function loadFolders(path = folderBrowse.path) {
    const generation = folderRequestGate.next();
    const list = $("#folderList");
    $("#folderConfirm").disabled = true;
    list.innerHTML = '<div class="list-state">Loading folders…</div>';
    try {
      const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`),
        data = await response.json();
      if (!folderRequestGate.isCurrent(generation)) return;
      if (!response.ok) throw new Error(data.error || "Cannot browse folder");
      folderBrowse = { path: data.path, parent: data.parent, selected: data.path };
      $("#folderPathInput").value = data.path;
      $("#folderSelection").textContent = data.path;
      $("#folderConfirm").disabled = false;
      $("#folderUp").disabled = !data.parent;
      list.innerHTML = "";
      for (const folder of data.folders) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "folder-item";
        b.innerHTML = `${icons.file}<span>${escapeHtml(folder.name)}</span>`;
        b.ondblclick = () => loadFolders(folder.path);
        b.onclick = () => {
          folderBrowse.selected = folder.path;
          $("#folderSelection").textContent = folder.path;
          $("#folderConfirm").disabled = false;
          list.querySelectorAll(".folder-item").forEach((x) => x.classList.remove("selected"));
          b.classList.add("selected");
        };
        list.append(b);
      }
      if (!data.folders.length) list.innerHTML = '<div class="list-state">No subfolders</div>';
    } catch (e) {
      if (!folderRequestGate.isCurrent(generation)) return;
      list.innerHTML = `<div class="list-state">${escapeHtml(e.message)}</div>`;
    }
  }
  function openFolderPicker() {
    const dialog = $("#folderDialog");
    folderBrowse.selected = null;
    dialog.showModal();
    loadFolders(
      state.projectless ? state.config.defaultCwd || "~/projects" : $("#projectPath").textContent || "~/projects",
    );
    $("#projectlessOption").classList.toggle("selected", state.projectless);
  }
  async function syncWorkspaceContext(path) {
    const requestId = workspaceContextRequestGate.next();
    try {
      const response = await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`, { cache: "no-store" }),
        context = await response.json();
      if (!response.ok) throw new Error(context.error || "Workspace context unavailable");
      if (!workspaceContextRequestGate.isCurrent(requestId) || state.projectless) return;
      mutations.set("workspaceContext", context);
      if (!state.active) timelinePort.showEmpty();
    } catch {
      if (workspaceContextRequestGate.isCurrent(requestId) && !state.projectless) {
        mutations.set("workspaceContext", {
          cwd: path,
          project: path.split("/").filter(Boolean).at(-1) || path,
          environment: "Local",
          branch: "No branch",
        });
        if (!state.active) timelinePort.showEmpty();
      }
    }
  }
  function syncProjectControl() {
    const button = $("#composerProjectButton"),
      picker = $("#conversationProjectPicker"),
      label = $("#composerProjectLabel"),
      hidden = Boolean(state.active) || !["workspace", "new", "task"].includes(parseWorkbenchRoute().page);
    button.hidden = hidden;
    if (picker) picker.hidden = hidden;
    label.textContent = state.projectless
      ? t("No working folder")
      : $("#projectName").textContent || t("Choose working folder");
  }
  function refreshComposerPlaceholder() {
    if (!state.active && state.composerMode === "local") {
      $("#prompt").placeholder = t("Describe a task, add files, or start with an idea…");
      return;
    }
    const followUpType = state.active ? (state.active.source === "cloud" ? "cloud" : "local") : undefined;
    $("#prompt").placeholder = resolveComposerPlaceholder({
      followUpType,
      composerMode: state.composerMode,
      cloudStartingState: state.cloudStartingState,
      isBackgroundSubagentsPanelVisible: state.backgroundAgentsVisible,
      isGoalModeActive: state.goalMode,
      isPlanModeActive: state.planMode,
      placeholderText: state.placeholderText,
      isHome: !state.active,
    });
  }
  function setWorkspace(path, refreshProfiles = true) {
    const name = path.split("/").filter(Boolean).at(-1) || path,
      resolved = path.replace(/^~/, state.config.home);
    workspaceContextRequestGate.next();
    mutations.set("projectless", false);
    mutations.set("workspaceContext", { cwd: resolved, project: name, environment: "Local", branch: null });
    $("#projectPath").textContent = shortPath(path);
    $("#projectName").textContent = name;
    storage.set(STORAGE_KEYS.project, path);
    syncProjectControl();
    if (!state.active) timelinePort.showEmpty();
    if (!$("#summaryPanel").hidden) viewUpdates.request("details");
    syncWorkspaceContext(resolved);
    if (state.connected && refreshProfiles) modelsPort.loadPermissionProfiles();
  }
  function setProjectless(refreshProfiles = true) {
    workspaceContextRequestGate.next();
    mutations.set("projectless", true);
    mutations.set("workspaceContext", null);
    $("#projectPath").textContent = "~";
    $("#projectName").textContent = t("Tasks");
    storage.set(STORAGE_KEYS.project, "~");
    syncProjectControl();
    if (!state.active) {
      $("#threadPath").textContent = "";
      timelinePort.showEmpty();
    }
    if (!$("#summaryPanel").hidden) viewUpdates.request("details");
    if (state.connected && refreshProfiles) modelsPort.loadPermissionProfiles();
  }
  async function selectWorkbenchProject(path) {
    const response = await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
    const context = await response.json();
    if (!response.ok) throw new Error(context.error || t("Project unavailable"));
    composerPort.saveComposerDraft();
    setWorkspace(context.cwd);
    navigationPort.startNewTask({ saveCurrentDraft: false });
    viewUpdates.request("workbench");
  }
  async function prepareBusinessSession(projectId) {
    if (!projectId) return;
    if (!projectsPort.businessProjects.ready) await projectsPort.businessProjects.load();
    if (!projectsPort.businessProjects.get(projectId)) throw new Error(t("Project not found"));
  }
  async function useSelectedFolder() {
    if (!folderBrowse.selected) return;
    const button = $("#folderConfirm");
    button.disabled = true;
    try {
      await selectWorkbenchProject(folderBrowse.selected);
      $("#folderDialog").close();
    } catch (error) {
      $("#folderList").innerHTML = `<div class="list-state" role="alert">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  }
  function useProjectless() {
    composerPort.saveComposerDraft();
    setProjectless();
    $("#folderDialog").close();
    navigationPort.startNewTask({ saveCurrentDraft: false });
  }
  function renderHeader() {
    viewUpdates.request("workbench");
    goalsPort.syncGoalDialogSession();
    queuePort.renderMessageQueue();
    const t = state.active;
    if (!t) {
      viewUpdates.request("goals");
      viewUpdates.request("status");
      return;
    }
    $("#threadTitle").textContent = titleOf(t);
    if (t.projectless) {
      mutations.set("projectless", true);
      mutations.set("workspaceContext", null);
      $("#projectName").textContent = "Tasks";
      $("#projectPath").textContent = "~";
      $("#threadPath").textContent = "";
    } else {
      $("#threadPath").textContent = shortPath(t.cwd);
      setWorkspace(t.cwd || state.config.home);
    }
    syncProjectControl();
    refreshComposerPlaceholder();
    $("#threadSource").textContent = t.source || "local";
    viewUpdates.request("goals");
    viewUpdates.request("status");
  }
  function bind() {
    $("#projectButton").onclick = (...args) => openFolderPicker(...args);
    $("#projectlessOption").onclick = (...args) => useProjectless(...args);
    $("#folderGo").onclick = () => loadFolders($("#folderPathInput").value);
    $("#folderPathInput").oninput = () => {
      folderRequestGate.next();
      folderBrowse.selected = null;
      $("#folderConfirm").disabled = true;
    };
    $("#folderPathInput").onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadFolders(e.currentTarget.value);
      }
    };
    $("#folderUp").onclick = () => folderBrowse.parent && loadFolders(folderBrowse.parent);
    $("#folderConfirm").onclick = (...args) => useSelectedFolder(...args);
  }
  return {
    bind,
    openFolderPicker,
    selectWorkbenchProject,
    setProjectless,
    syncProjectControl,
    renderHeader,
    prepareBusinessSession,
    refreshComposerPlaceholder,
    setWorkspace,
    useProjectless,
    get folderBrowse() {
      return folderBrowse;
    },
  };
}
