import { localizeAttribute, localizeText, setMessageHtml, setOpaqueAttribute, setOpaqueText } from "../i18n.js";
import { errorMessage } from "./../../shared/errors.js";
import { findElements } from "./../dom.js";
import { request as fetch } from "./../http-client.js";

import { codexIcon } from "../codex-icons.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { createLatestRequestGate, resolveComposerPlaceholder } from "../ui-core.js";
import { parseWorkbenchRoute } from "../workbench-route.js";

// Owns workspace state and operations; peers are explicit application ports.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "$" | "escapeHtml" | "state" | "t" | "shortPath" | "titleOf", "timeline" | "models" | "composer" | "navigation" | "projects" | "goals" | "queue", "workspace">} options */
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
    setMessageHtml(
      list,
      '<div class="list-state"><span data-pf-message="common.loadingFolders">Loading folders…</span></div>',
    );
    try {
      const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`),
        data = await response.json();
      if (!folderRequestGate.isCurrent(generation)) return;
      if (!response.ok) throw new Error(data.error || "Cannot browse folder");
      folderBrowse = { path: data.path, parent: data.parent, selected: data.path };
      $("#folderPathInput").value = data.path;
      setOpaqueText($("#folderSelection"), data.path);
      $("#folderConfirm").disabled = false;
      $("#folderUp").disabled = !data.parent;
      setMessageHtml(list, "");
      for (const folder of data.folders) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "folder-item";
        setMessageHtml(b, `${icons.file}<span>${escapeHtml(folder.name)}</span>`);
        b.ondblclick = () => loadFolders(folder.path);
        b.onclick = () => {
          folderBrowse.selected = folder.path;
          setOpaqueText($("#folderSelection"), folder.path);
          $("#folderConfirm").disabled = false;
          findElements(".folder-item", list).forEach((x) => x.classList.remove("selected"));
          b.classList.add("selected");
        };
        list.append(b);
      }
      if (!data.folders.length)
        setMessageHtml(
          list,
          '<div class="list-state"><span data-pf-message="common.noSubfolders">No subfolders</span></div>',
        );
    } catch (e) {
      if (!folderRequestGate.isCurrent(generation)) return;
      setMessageHtml(list, `<div class="list-state">${escapeHtml(errorMessage(e))}</div>`);
    }
  }
  function openFolderPicker() {
    if (
      !state.active &&
      state.newSessionProjectId &&
      projectsPort.businessProjects.get(state.newSessionProjectId)?.workspace
    )
      return;
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
    const managed =
      !state.active &&
      state.newSessionProjectId &&
      projectsPort.businessProjects.get(state.newSessionProjectId)?.workspace;
    button.hidden = hidden;
    button.disabled = Boolean(managed);
    if (picker) picker.hidden = hidden;
    const caption = picker?.querySelector(".working-folder-label");
    if (caption) localizeText(caption, managed ? "projects.workspacePath" : "common.workingFolder", undefined, t);
    localizeAttribute(button, "aria-label", managed ? "projects.workspacePath" : "common.workingFolder", undefined, t);
    setOpaqueText(
      label,
      state.projectless
        ? t("common.noWorkingFolder")
        : $("#projectName").textContent || t("common.chooseWorkingFolder"),
    );
  }
  function applySelectedProjectWorkspace() {
    if (state.active || !state.newSessionProjectId) return;
    const workspace = projectsPort.businessProjects.get(state.newSessionProjectId)?.workspace;
    if (workspace?.state === "ready" && state.workspaceContext?.cwd !== workspace.path) setWorkspace(workspace.path);
  }
  function refreshComposerPlaceholder() {
    if (!state.active && state.composerMode === "local") {
      localizeAttribute($("#prompt"), "placeholder", "workbench.describeATaskAddFilesOrStartWithAnIdea", undefined, t);
      return;
    }
    const followUpType = state.active ? (state.active.source === "cloud" ? "cloud" : "local") : undefined;
    setOpaqueAttribute(
      $("#prompt"),
      "placeholder",
      resolveComposerPlaceholder({
        followUpType,
        composerMode: state.composerMode,
        cloudStartingState: state.cloudStartingState,
        isBackgroundSubagentsPanelVisible: state.backgroundAgentsVisible,
        isGoalModeActive: state.goalMode,
        isPlanModeActive: state.planMode,
        placeholderText: state.placeholderText,
        isHome: !state.active,
      }),
    );
  }
  function setWorkspace(path, refreshProfiles = true) {
    const name = path.split("/").filter(Boolean).at(-1) || path,
      resolved = path.replace(/^~/, state.config.home);
    workspaceContextRequestGate.next();
    mutations.set("projectless", false);
    mutations.set("workspaceContext", { cwd: resolved, project: name, environment: "Local", branch: null });
    setOpaqueText($("#projectPath"), shortPath(path));
    setOpaqueText($("#projectName"), name);
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
    setOpaqueText($("#projectPath"), "~");
    localizeText($("#projectName"), "common.tasks", undefined, t);
    storage.set(STORAGE_KEYS.project, "~");
    syncProjectControl();
    if (!state.active) {
      setOpaqueText($("#threadPath"), "");
      timelinePort.showEmpty();
    }
    if (!$("#summaryPanel").hidden) viewUpdates.request("details");
    if (state.connected && refreshProfiles) modelsPort.loadPermissionProfiles();
  }
  async function selectWorkbenchProject(path) {
    const response = await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
    const context = await response.json();
    if (!response.ok) throw new Error(context.error || t("workbench.projectUnavailable"));
    composerPort.saveComposerDraft();
    setWorkspace(context.cwd);
    navigationPort.startNewTask({ saveCurrentDraft: false });
    viewUpdates.request("workbench");
  }
  async function prepareBusinessSession(projectId) {
    if (!projectId) return;
    if (!projectsPort.businessProjects.ready) await projectsPort.businessProjects.load();
    if (!projectsPort.businessProjects.get(projectId)) throw new Error(t("errors.projectNotFound"));
    return projectsPort.businessProjects.workspace(projectId);
  }
  async function useSelectedFolder() {
    if (!folderBrowse.selected) return;
    const button = $("#folderConfirm");
    button.disabled = true;
    try {
      await selectWorkbenchProject(folderBrowse.selected);
      $("#folderDialog").close();
    } catch (error) {
      setMessageHtml($("#folderList"), `<div class="list-state" role="alert">${escapeHtml(errorMessage(error))}</div>`);
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
    setOpaqueText($("#threadTitle"), titleOf(t));
    if (t.projectless) {
      mutations.set("projectless", true);
      mutations.set("workspaceContext", null);
      localizeText($("#projectName"), "common.tasks", undefined);
      setOpaqueText($("#projectPath"), "~");
      setOpaqueText($("#threadPath"), "");
    } else {
      setOpaqueText($("#threadPath"), shortPath(t.cwd));
      setWorkspace(t.cwd || state.config.home);
    }
    syncProjectControl();
    refreshComposerPlaceholder();
    setOpaqueText($("#threadSource"), t.source || "local");
    viewUpdates.request("goals");
    viewUpdates.request("status");
  }
  function bind() {
    $("#projectButton").onclick = /** @param {Parameters<typeof openFolderPicker>} args */ (...args) =>
      openFolderPicker(...args);
    $("#projectlessOption").onclick = /** @param {Parameters<typeof useProjectless>} args */ (...args) =>
      useProjectless(...args);
    $("#folderGo").onclick = () => loadFolders($("#folderPathInput").value);
    $("#folderPathInput").oninput = () => {
      folderRequestGate.next();
      folderBrowse.selected = null;
      $("#folderConfirm").disabled = true;
    };
    $("#folderPathInput").onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadFolders($("#folderPathInput").value);
      }
    };
    $("#folderUp").onclick = () => folderBrowse.parent && loadFolders(folderBrowse.parent);
    $("#folderConfirm").onclick = /** @param {Parameters<typeof useSelectedFolder>} args */ (...args) =>
      useSelectedFolder(...args);
  }
  return {
    applySelectedProjectWorkspace,
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
