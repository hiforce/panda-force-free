/**
 * Browser composition entry point. Native notifications own conversation state;
 * timeline rendering must not invent engine events or replay a lost mutation.
 * Keep transport recovery, per-session drafts and request IDs independent so a
 * background refresh cannot resend input or resolve a request in another thread.
 * Domain controllers live in sibling modules; this file still contains legacy
 * timeline orchestration recorded for staged extraction in the audit report.
 */
import { createWorkbench } from "./workbench.js";
import { createProjectCatalog } from "./project-catalog.js";
import { activityText, mergeReasoningItem } from "../shared/activity-text.js";
import { applyThemePreference } from "./theme.js";
import { createConversationCache, isConversationCacheExpired } from "./conversation-cache.js";
import { normalizeProjectPath } from "../shared/project-visibility.js";
import { trackMobileViewport } from "./mobile-viewport.js";
import { createAnchoredMenu } from "./anchored-menu.js";
import { createTransport } from "./transport.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { createSidebarCache } from "./sidebar-cache.js";
import { takeStartupRead } from "./startup-reads.js";
import { getWorkspacePreparation } from "./workspace-preparation.js";
import { createSettingsPanel } from "./settings.js";
import { createUsagePanel } from "./usage-panel.js";
import { createTerminalPanel } from "./terminal-panel.js";
import { createBrowserController } from "./browser-panel-controller.js";
import { createComposerDrafts } from "./composer-drafts.js";
import { createThreadSidebar } from "./threads-sidebar.js";
import { createAccountView } from "./account-view.js";
import { createSessionControls } from "./session-controls.js";
import { readAsyncQuestions, createAsyncQuestionCard, closeEarlierAsyncQuestions } from "./async-questions.js";
import { createApprovals } from "./approvals.js";
import {
  DEFAULT_TURN_PAGE_SIZE,
  applyComposerSuggestion,
  createLatestRequestGate,
  createTurnWindow,
  mergeConversationHistory,
  filterAppModels,
  formatActivityAge,
  threadLastActivityAt,
  getComposerAutocomplete,
  resolveComposerPlaceholder,
} from "./ui-core.js";
import { agentMessageText, localImageUrl, renderAssistantMarkdown, renderItemImages } from "./rendering.js";
import { createFilePreview } from "./lazy-file-preview.js";
import { createFilesPanel } from "./files-panel.js";
import { codexIcon, hydrateCodexIcons } from "./codex-icons.js";
import { pandaInterfaceMark } from "./panda-brand.js";
import { createDomI18n, createI18n } from "./i18n.js";
import {
  buildApprovalModel,
  createReviewPreferences,
  parseUnifiedDiff,
  permissionRows,
  splitDiffHunk,
  summarizeActivity,
  unifiedDiffFromFileChanges,
} from "../shared/codex-surfaces.js";
import {
  THREAD_NOT_FOUND,
  NO_ACTIVE_TURN,
  bridgeErrorCode,
  createBridgeError,
  threadInputErrorMessage,
} from "../shared/bridge-errors.js";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  filesFromClipboard,
  buildComposerInput,
  attachmentsFromInput,
  composerTextFromInput,
  composerInputKey,
} from "./composer-attachments.js";
import { attachmentDisplayUrl, configureAttachmentUrls } from "../shared/attachment-urls.js";
globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
const $ = (s) => document.querySelector(s);
const approvalMenuController = createAnchoredMenu();
const i18n = globalThis.__pandaForceI18n || createI18n();
globalThis.__pandaForceI18n = i18n;
globalThis.__pandaForceDomI18n = globalThis.__pandaForceDomI18n || createDomI18n(i18n);
const t = (message, values) => i18n.t(message, values);
const workspacePreparation = getWorkspacePreparation();
let workbench;
i18n.subscribe(() => workspacePreparation.refresh());
addEventListener("pagehide", () => workspacePreparation.dispose(), { once: true });
const filePreview = createFilePreview({
  t,
  onBackToFiles: () => openFilesDialog(),
  getAttachmentUrlPrefix: () => state.config.attachmentUrlPrefix,
  onError: () => {
    globalThis.__pandaForceCheckAuth?.();
    addPersistentError(t("Could not load file preview. Please retry."));
  },
});
const filesDialog = document.querySelector("#filesDialog");
const filesPanel = createFilesPanel({
  t,
  onOpenFile: (reference) => {
    if (!matchMedia("(min-width: 900px)").matches) closeFilesDialog();
    filePreview.open(reference);
  },
  onChooseProject: () => {
    closeFilesDialog();
    openFolderPicker();
  },
  shortPath,
});
const state = {
  ws: null,
  events: null,
  transport: "connecting",
  wsFallbackTimer: null,
  rpcId: 1,
  pending: new Map(),
  threads: [],
  active: null,
  models: [],
  modelLoadStatus: "loading",
  selectedModel: "",
  workspaceContext: null,
  newSessionProjectId: new URL(location.href).searchParams.get("project") || null,
  projectless: false,
  composerMode: "local",
  planMode: false,
  permissionMode: storage.get(STORAGE_KEYS.permissionMode) || "default",
  permissionProfiles: [],
  permissionVisibility: {
    autoReview: true,
    fullAccess: storage.get(STORAGE_KEYS.permissionFullAccess) !== "false",
  },
  goalMode: false,
  goals: new Map(),
  backgroundAgentsVisible: false,
  cloudStartingState: null,
  placeholderText: null,
  composerMentions: [],
  composerAttachments: [],
  turnWindow: null,
  tokenUsage: new Map(),
  items: new Map(),
  turns: new Map(),
  turnTimings: new Map(),
  sessionSettings: new Map(),
  activities: new Map(),
  activityItems: new Map(),
  sideTasks: new Map(),
  dividers: new Map(),
  changes: new Map(),
  requestCards: new Map(),
  turnDiffs: new Map(),
  activeReview: null,
  persistentErrors: [],
  account: null,
  connected: false,
  config: { home: "", defaultCwd: "", projectless: false },
};
const businessProjects = createProjectCatalog({
  state,
  onChange: () =>
    queueMicrotask(() => {
      renderThreads();
      workbench?.refresh();
    }),
});
let folderBrowse = { path: "~", parent: null, selected: null };
const reviewPreferences = createReviewPreferences(JSON.parse(storage.get(STORAGE_KEYS.reviewPreferences) || "{}"));
let reviewPatchState = "undo";
let sidePanelReturnFocus = null,
  summaryPanelReturnFocus = null,
  imageViewerReturnFocus = null;
let sidebarLayoutMobile = null;
const { terminalStates, fitTerminal, initializeTerminal } = createTerminalPanel({
  $,
  t,
  getCwd: () => currentTerminalCwd(),
  onAuthCheck: () => globalThis.__pandaForceCheckAuth?.(),
});
const { browserState, navigateBrowser, moveBrowserHistory, updateBrowserControls } = createBrowserController({ $ });
const threadNavigationGate = createLatestRequestGate();
const {
  composerHistory,
  loadComposerHistory,
  persistComposerDraft,
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} = createComposerDrafts({
  getActiveThreadId: () => state.active?.id,
  getNewDraftKey: () =>
    "__new__:project:" +
    (state.newSessionProjectId || "unassigned") +
    ":" +
    (state.projectless ? "projectless" : state.workspaceContext?.cwd || state.config.defaultCwd || "default"),
  getLegacyNewDraftKey: () =>
    state.newSessionProjectId
      ? null
      : "__new__:" +
        (state.projectless ? "projectless" : state.workspaceContext?.cwd || state.config.defaultCwd || "default"),
  migrateLegacyGlobalDraft: () => !state.newSessionProjectId,
  getDraftSnapshot: () => ({
    text: $("#prompt").value,
    mentions: [...state.composerMentions],
    attachments: [...state.composerAttachments],
  }),
});
const promptSubmissions = new Map();
const pendingUserMessages = new Map();
const queuedMessages = new Map();
const settledQueueMessages = new Set();
const queueReadVersions = new Map();
let localUserSequence = 0;
let renderingTurn = false;
const pendingActivitySummaries = new Set();
let pendingTurnReview = false,
  pendingChangesRender = false,
  pendingSideTasksRender = false;
let conversationAutoScroll = true;
const conversationCache = new Map();
const persistentConversationCache = createConversationCache();
const sidebarCache = createSidebarCache({ storage, key: STORAGE_KEYS.sidebarSnapshot });
const cachedSidebar = sidebarCache.read();
let threadListHasFreshData = false;
if (cachedSidebar) {
  state.threads = cachedSidebar.threads;
  state.config.home = cachedSidebar.home || "";
}
const persistedConversationVersions = new Map();
function evictConversationMemory(id) {
  conversationCache.delete(id);
  persistedConversationVersions.delete(id);
}
function pruneConversationCaches() {
  for (const [id, thread] of conversationCache) if (isConversationCacheExpired(thread)) evictConversationMemory(id);
  void persistentConversationCache.prune().then((ids) => ids?.forEach(evictConversationMemory));
}
function cacheConversation(thread) {
  if (isConversationCacheExpired(thread)) {
    evictConversationMemory(thread.id);
    return;
  }
  conversationCache.delete(thread.id);
  conversationCache.set(thread.id, thread);
  while (conversationCache.size > 8) evictConversationMemory(conversationCache.keys().next().value);
  if (thread.history?.revision && persistedConversationVersions.get(thread.id) !== thread.history.revision) {
    persistedConversationVersions.set(thread.id, thread.history.revision);
    void persistentConversationCache.put(thread);
  }
}
let threadNavigationGeneration = 0;
const {
  usagePageVisible,
  renderUsage,
  scheduleUsageRefresh,
  loadUsage,
  resetUsage,
  showUsageDisconnected,
  applyPushedUsageLimits,
  pauseUsageRefresh,
} = (() => {
  const panel = createUsagePanel({ $, t, i18n, state, rpc: (method, params) => rpc(method, params) });
  return {
    ...panel,
    showUsageDisconnected: panel.showDisconnected,
    applyPushedUsageLimits: panel.applyPushedLimits,
    pauseUsageRefresh: panel.pauseRefresh,
  };
})();

const workspaceContextRequestGate = createLatestRequestGate();
const autocompleteState = { match: null, items: [], selected: 0, requestId: 0, message: "" };
const initialLoadGate = createLatestRequestGate();
let initialConfigReady = Promise.resolve();
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
  state,
  rpc: (method, params) => rpc(method, params),
  postBridge: (path, payload, signal) => postBridge(path, payload, signal),
  escapeHtml: (value) => escapeHtml(value),
  toast: (...args) => toast(...args),
  addPersistentError: (message) => addPersistentError(message),
});

function loadModels(options) {
  return workspacePreparation.track("models", loadModelsRaw(options));
}
function loadPermissionProfiles() {
  return workspacePreparation.track("permissions", loadPermissionProfilesRaw());
}

const ACTIVE_THREAD_SYNC_ACTIVE_MS = 800,
  ACTIVE_THREAD_SYNC_IDLE_MS = 2400,
  THREAD_LIST_POLL_MS = 3000;
// Keep the first history response small enough to render immediately. Once the
// latest messages are visible, an older page is fetched in the background.
const INITIAL_CONVERSATION_HISTORY_LIMIT = 20;
const BACKGROUND_CONVERSATION_HISTORY_LIMIT = 100;
let activeThreadSyncTimer = null,
  activeThreadSyncGeneration = 0,
  activeThreadSyncInFlight = false,
  activeThreadSyncSignature = "",
  threadListTimer = null,
  threadListInFlight = false,
  threadListSignature = "";

const icons = {
  chevron: codexIcon("chevronRight", "activity-chevron"),
  terminal: codexIcon("terminal"),
  file: codexIcon("file"),
  search: codexIcon("search"),
  tool: codexIcon("wrench"),
  check: codexIcon("check"),
};
hydrateCodexIcons();
$("#windowCodexMark").innerHTML = pandaInterfaceMark("window-panda-mark");
$("#emptyCodexMark").innerHTML = pandaInterfaceMark("empty-panda-mark");

const { connect, rpc, respondToCodex, postBridge, clearTransportReconnectTimer, resetReconnectBackoff } =
  createTransport({
    state,
    onMessage: (message) => handle(message),
    setStatus: (kind, text) => setStatus(kind, text),
    onAuthCheck: () => globalThis.__pandaForceCheckAuth?.(),
    onSseDisrupted: () => {
      workspacePreparation.start("connection");
      initialLoadGate.next();
      scheduleThreadListRefresh(0);
      scheduleActiveThreadSync(0);
    },
    onProjectVisibility: (snapshot) => applyProjectVisibility(snapshot),
    translate: (message) => t(message),
  });

const {
  renderThreads,
  applyProjectVisibility,
  loadProjectVisibility: loadProjectVisibilityRaw,
  getProjects,
  setProjectHidden,
  toggleProjectPinned,
  isProjectPinned,
} = createThreadSidebar({
  $,
  t,
  state,
  projectCatalog: businessProjects,
  onProjectNewSession: (projectId) => startNewTask({ projectId }),
  onSessionProject: (id) => workbench?.associateSession(id),
  initialVisibility: cachedSidebar?.visibility,
  onRender: () => workbench?.refresh(),
  onVisibility: (snapshot) => sidebarCache.saveVisibility(snapshot),
  readVisibility: () =>
    takeStartupRead("visibility", async () => {
      const response = await fetch("/api/projects/visibility", { cache: "no-store" });
      if (!response.ok) throw new Error(t("Could not load projects"));
      return response.json();
    }),
  rpc: (method, params) => rpc(method, params),
  escapeHtml: (value) => escapeHtml(value),
  shortPath: (path) => shortPath(path),
  titleOf: (thread) => titleOf(thread),
  openThread: (id) => openThread(id),
  startNewTask: () => startNewTask(),
  setWorkspace: (path) => setWorkspace(path),
  setProjectless: () => setProjectless(),
  chooseProject: (path) => selectWorkbenchProject(path),
  chooseProjectless: () => useProjectless(),
  mobileSidebarEnabled: () => mobileSidebarEnabled(),
  setSidebarOpen: (open) => setSidebarOpen(open),
  updateThreadRowMeta: (row, thread, meta) => updateThreadRowMeta(row, thread, meta),
  submitNativeSlashCommand: (thread, command) => submitNativeSlashCommand(thread, command),
  toast: (...args) => toast(...args),
  toastProject: () => toast.project,
  dismissToast: () => dismissToast(),
  addPersistentError: (message) => addPersistentError(message),
  refreshThreadList: () => refreshThreadList(),
  cleanupDeletedThread: (threadId) => {
    evictConversationMemory(threadId);
    state.goals.delete(threadId);
    threadErrors.delete(threadId);
  },
  removeCachedConversation: (threadId) => {
    sidebarCache.remove(threadId);
    return persistentConversationCache.remove(threadId);
  },
});

function loadProjectVisibility() {
  return workspacePreparation.track("projects", Promise.all([loadProjectVisibilityRaw(), businessProjects.load()]));
}

function handle(message) {
  if (message.type === "project-catalog/changed") {
    businessProjects.apply(message);
    return;
  }
  if (message.type === "projects/visibility") {
    applyProjectVisibility(message);
    return;
  }
  if (message.type === "bridge/status") {
    if (message.status === "connected") {
      workspacePreparation.complete("connection");
      const shouldLoad = !state.connected;
      state.connected = true;
      resetReconnectBackoff();
      clearTransportReconnectTimer();
      setStatus("connected", "Codex connected");
      if (shouldLoad) {
        loadInitial();
        requestTaskNotifyPermission();
      } else {
        refreshThreadList();
        scheduleActiveThreadSync(0);
      }
    } else {
      initialLoadGate.next();
      if (message.status === "disconnected") {
        clearApprovals({ removeCards: true });
      }
      state.connected = false;
      workspacePreparation.start("connection");
      showUsageDisconnected();
      setStatus("connecting", "Connecting to Codex");
    }
    return;
  }
  if (message.type === "rpc/result" || message.type === "rpc/error" || message.type === "ack") {
    if (message.projectVisibility) applyProjectVisibility(message.projectVisibility);
    const p = state.pending.get(message.id);
    if (!p) return;
    state.pending.delete(message.id);
    message.type === "rpc/error" ? p.reject(createBridgeError(message.error, message.code)) : p.resolve(message.result);
    return;
  }
  if (message.type === "codex/notification") onNotification(message.payload.method, message.payload.params || {});
  if (message.type === "codex/request") onServerRequest(message.payload);
}
function setStatus(kind, text) {
  workbench?.refresh();
  $("#statusDot").className = "status-dot" + (kind === "connected" ? " connected" : kind === "error" ? " error" : "");
  $("#statusText").textContent = t(text || kind);
}
async function loadInitial(refreshAccount = false) {
  workspacePreparation.start("sessions");
  const generation = initialLoadGate.next(),
    current = () => initialLoadGate.isCurrent(generation);
  loadAccount(refreshAccount);
  void refreshPendingApprovals();
  loadComposerHistory();
  void loadProjectVisibility().catch(() => {});
  if (usagePageVisible()) loadUsage();
  if (!state.threads.length)
    $("#threadList").innerHTML = `<div class="list-state">${escapeHtml(t("Loading sessions…"))}</div>`;
  const report = (error) => {
    if (current() && !error?.silentTransportSwitch) addPersistentError(error.message);
  };
  const models = loadModels();
  const rememberedId = storage.get(STORAGE_KEYS.activeThread);
  const rememberedThread = startupThreadAllowed(rememberedId) ? rememberedId : null;
  const cachedConversation = restoreCachedStartup(rememberedThread, current);
  if (state.active?.history) scheduleActiveThreadSync(0);
  const threads = takeStartupRead("threads", () =>
    rpc("thread/list", { limit: 50, sortKey: "recency_at", sortDirection: "desc" }),
  )
    .then(async (result) => {
      if (!current()) return;
      applyThreadSummaries(result.data || []);
      scheduleThreadListRefresh();
      await initialConfigReady;
      if (!current()) return;
      await cachedConversation;
      if (!current()) return;
      if (!state.active && rememberedThread && rememberedThread === storage.get(STORAGE_KEYS.activeThread))
        await openThread(rememberedThread);
    })
    .catch((error) => {
      if (current() && !error?.silentTransportSwitch) workspacePreparation.fail("sessions");
      if (current()) {
        scheduleThreadListRefresh();
        if (!state.threads.length) {
          const cached = sidebarCache.read();
          if (cached?.threads.length) {
            state.threads = cached.threads;
            renderThreads();
          } else
            $("#threadList").innerHTML = `<div class="list-state">${escapeHtml(t("Could not load sessions"))}</div>`;
        }
      }
      report(error);
    });
  const profiles = initialConfigReady.then(() => (current() ? loadPermissionProfiles() : null));
  await Promise.allSettled([models, threads, profiles]);
  if (!state.active) {
    restoreComposerDraft();
    renderContextTray();
  }
}
const {
  openSettings,
  showSettings,
  closeSettings,
  hideSettings,
  setSettingsPage,
  settingsRoutePage,
  filterSettingsNavigation,
} = createSettingsPanel({
  $,
  t,
  state,
  shortPath: (path) => shortPath(path),
  agentRows: () => [
    ["Model", modelDisplay(selectedModel())],
    ["Reasoning effort", reasoningLabel($("#effortSelect").value)],
    ["Approval", selectedPermission().label],
    ["Web search", "Automatic"],
  ],
  permissionLabel: () => selectedPermission().label,
  openUsageSummary: () => openUsageSummary(),
  toggleAccountMenu: (force) => toggleAccountMenu(force),
  syncPermissionSettings: () => syncPermissionSettings(),
});
const { loadAccount, renderAccount, toggleAccountMenu } = createAccountView({
  $,
  t,
  state,
  setSettingsPage: (page) => setSettingsPage(page),
  filterSettingsNavigation: (query) => filterSettingsNavigation(query),
  syncPermissionSettings: () => syncPermissionSettings(),
  syncPermissionControl: () => syncPermissionControl(),
});
async function loadFolders(path = folderBrowse.path) {
  const list = $("#folderList");
  list.innerHTML = '<div class="list-state">Loading folders…</div>';
  try {
    const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`),
      data = await response.json();
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
    state.workspaceContext = context;
    if (!state.active) showEmpty();
  } catch {
    if (workspaceContextRequestGate.isCurrent(requestId) && !state.projectless) {
      state.workspaceContext = {
        cwd: path,
        project: path.split("/").filter(Boolean).at(-1) || path,
        environment: "Local",
        branch: "No branch",
      };
      if (!state.active) showEmpty();
    }
  }
}
function syncProjectControl() {
  const button = $("#composerProjectButton"),
    picker = $("#conversationProjectPicker"),
    label = $("#composerProjectLabel"),
    hidden =
      Boolean(state.active) || Boolean(workbench && !["workspace", "new", "task"].includes(workbench.route.page));
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
  state.projectless = false;
  state.workspaceContext = { cwd: resolved, project: name, environment: "Local", branch: null };
  $("#projectPath").textContent = shortPath(path);
  $("#projectName").textContent = name;
  storage.set(STORAGE_KEYS.project, path);
  syncProjectControl();
  if (!state.active) showEmpty();
  if (!$("#summaryPanel").hidden) syncSummaryPanel();
  syncWorkspaceContext(resolved);
  if (state.connected && refreshProfiles) loadPermissionProfiles();
}
function setProjectless(refreshProfiles = true) {
  workspaceContextRequestGate.next();
  state.projectless = true;
  state.workspaceContext = null;
  $("#projectPath").textContent = "~";
  $("#projectName").textContent = t("Tasks");
  storage.set(STORAGE_KEYS.project, "~");
  syncProjectControl();
  if (!state.active) {
    $("#threadPath").textContent = "";
    showEmpty();
  }
  if (!$("#summaryPanel").hidden) syncSummaryPanel();
  if (state.connected && refreshProfiles) loadPermissionProfiles();
}
function resetReviewState() {
  state.turnDiffs.clear();
  state.activeReview = null;
  reviewPatchState = "undo";
  $("#reviewTab").hidden = true;
  if (!$("#reviewPanelContent").hidden) setSidePanelView("launcher", "New tab");
  renderChanges();
}
function clearConversationRuntime() {
  approvalMenuController.close();
  state.items.clear();
  state.turns.clear();
  state.turnTimings.clear();
  state.activities.clear();
  state.activityItems.clear();
  state.sideTasks.clear();
  state.dividers.clear();
  // The request inbox is independent of the conversation. Keep its live
  // cards registered when history or transport recovery rebuilds the timeline.
  for (const [id, card] of state.requestCards)
    if (!card.isConnected || !card.closest("#approvalInboxDialog")) state.requestCards.delete(id);
  renderSideTasks();
}
function rememberActiveThread(id) {
  if (id) storage.set(STORAGE_KEYS.activeThread, String(id));
  else storage.remove(STORAGE_KEYS.activeThread);
}
function saveComposerDraft() {
  persistComposerDraft();
}
function restoreComposerDraft() {
  composerHistory.setReplay(
    (state.active?.turns || []).flatMap((turn) =>
      (turn.items || [])
        .filter((item) => item.type === "userMessage")
        .map((item) => ({
          text: composerTextFromInput(item.content),
          attachments: attachmentsFromInput(item.content),
        })),
    ),
  );
  const draft = getComposerDraft();
  $("#prompt").value = draft?.text || "";
  state.composerMentions = draft?.mentions || [];
  state.composerAttachments = [...(draft?.attachments || [])];
  renderComposerAttachments();
  resizePrompt();
}
function startNewTask({
  saveCurrentDraft = true,
  projectId = state.active
    ? businessProjects.projectForSession(state.active.id)?.id || null
    : state.newSessionProjectId || null,
} = {}) {
  if (saveCurrentDraft) saveComposerDraft();
  state.newSessionProjectId = projectId;
  workbench?.taskStarted();
  closeGoalDialog();
  composerHistory.setReplay([]);
  threadNavigationGeneration++;
  threadNavigationGate.next();
  resetActiveThreadSync();
  setActiveTurnId("");
  rememberActiveThread(null);
  state.active = null;
  state.composerMentions = [];
  state.composerAttachments = [];
  state.turnWindow = null;
  clearConversationRuntime();
  state.changes.clear();
  resetReviewState();
  closeComposerAutocomplete();
  $("#threadTitle").textContent = t("New session");
  $("#threadPath").textContent = state.projectless ? "" : $("#projectPath").textContent;
  restoreComposerDraft();
  setPlanMode(false);
  syncProjectControl();
  renderContextTray();
  renderContextUsage();
  resizePrompt();
  if (!$("#summaryPanel").hidden) syncSummaryPanel();
  showEmpty();
  renderThreads();
  syncGoalStatusSurface();
  syncSessionStatusSurface();
  $("#prompt").focus();
}
async function selectWorkbenchProject(path) {
  const response = await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
  const context = await response.json();
  if (!response.ok) throw new Error(context.error || t("Project unavailable"));
  saveComposerDraft();
  setWorkspace(context.cwd);
  startNewTask({ saveCurrentDraft: false });
  workbench?.rememberProject(context.cwd);
}
async function prepareBusinessSession(projectId) {
  if (!projectId) return;
  if (!businessProjects.ready) await businessProjects.load();
  if (!businessProjects.get(projectId)) throw new Error(t("Project not found"));
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
  saveComposerDraft();
  setProjectless();
  $("#folderDialog").close();
  startNewTask({ saveCurrentDraft: false });
}
function titleOf(t) {
  return (t.name || t.preview || "Untitled session").replace(/\s+/g, " ").trim().slice(0, 110);
}
function shortPath(path = "") {
  const home = state.config.home;
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}
const threadRunningTurns = new Map();
const threadRuntimeTurns = new Map();
const threadErrors = new Map();
function errorMessage(value) {
  const message =
    typeof value === "string"
      ? value.trim()
      : value && typeof value === "object"
        ? String(
            value.message || value.error?.message || value.error || value.failure?.message || value.failure || "",
          ).trim()
        : "";
  return ["failed", "error", "errored", "systemerror"].includes(message.toLowerCase()) ? "" : message;
}
function errorStatus(status) {
  const type = typeof status === "string" ? status : status?.type;
  return ["error", "errored", "failed"].includes(String(type || "").toLowerCase());
}
function latestSessionTurnStatus(thread) {
  const runtime = threadRuntimeTurns.get(thread?.id),
    history = state.active?.id === thread?.id ? state.active : thread,
    turn = history?.turns?.at(-1);
  if (!runtime) return turn?.status || "";
  if (!turn || runtime.id === turn.id || runtime.historyTailId === turn.id)
    return runtime.status === "idle" && runtime.id === turn?.id ? turn.status : runtime.status || turn?.status || "";
  return turn.status || runtime.status || "";
}

function sessionHasSuccessfulLatestTurn(thread) {
  return (
    !sessionHasActiveLatestTurn(thread) &&
    ["completed", "interrupted", "cancelled", "canceled"].includes(latestSessionTurnStatus(thread))
  );
}
function sessionHasActiveLatestTurn(thread) {
  if (!thread?.id) return false;
  const threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
  // Native activity can precede the new turn's first persisted visible item.
  if (threadStatus === "active") return true;
  const status = latestSessionTurnStatus(thread);
  if (status === "inProgress") return true;
  if (["completed", "interrupted", "cancelled", "canceled", "failed", "error", "errored"].includes(status))
    return false;
  return threadRunningTurns.has(thread.id);
}

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
  $("#goalDialogStatus").textContent = t(
    {
      active: "Goal in progress",
      paused: "Goal paused",
      blocked: "Goal blocked",
      usage_limited: "Goal usage limited",
      budget_limited: "Goal budget limited",
      completed: "Goal completed",
      failed: "Goal failed",
    }[goal.status] || "Goal in progress",
  );
  $("#goalDialogObjective").value = goal.objective || "";
  $("#goalDialogObjective").setCustomValidity("");
  $("#goalDialogDetail").textContent = [goal.detail || goal.message, goalProgressText(goal.progress)]
    .filter(Boolean)
    .join(" · ");
  $("#goalDialogError").hidden = true;
  $("#goalDialogObjective").setAttribute("aria-label", t("Goal objective"));
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
    input.setCustomValidity(t("Goal objective cannot be empty"));
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  $("#goalDialogError").hidden = true;
  button.disabled = true;
  button.textContent = t("Saving…");
  try {
    const result = await rpc("thread/goal/set", { threadId, objective, origin: "user" });
    if (result?.goal) applyGoalStatusEvent("thread/goal/updated", { threadId, goal: result.goal });
    if (goalDialogThreadId === threadId && goalDialogGoalId === goalId) closeGoalDialog();
    toast(t("Goal updated"));
  } catch (error) {
    if (goalDialogThreadId === threadId) {
      $("#goalDialogError").textContent = error.message;
      $("#goalDialogError").hidden = false;
    }
  } finally {
    button.disabled = false;
    button.textContent = t("Save");
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
      active: "Goal in progress",
      paused: "Goal paused",
      blocked: "Goal blocked",
      usage_limited: "Goal usage limited",
      budget_limited: "Goal budget limited",
      completed: "Goal completed",
      failed: "Goal failed",
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
  root.setAttribute("aria-label", `${t("Goal status")}: ${label}${progress ? ` — ${progress}` : ""}`);
  root.title = `${label}${progress ? ` · ${progress}` : ""}`;
  root.innerHTML = `<span class="goal-status-icon" aria-hidden="true">${codexIcon(icons[goal.status] || icons.active)}</span><span class="goal-status-copy">${escapeHtml(label)}</span>${progress ? `<span class="goal-status-progress">${escapeHtml(progress)}</span>` : ""}<button type="button" class="goal-status-toggle" aria-haspopup="dialog" aria-controls="goalDialog">${t("Show Goal details")}</button>`;
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
    menu.setAttribute("aria-label", t("Goal actions"));
    for (const [command, labelKey] of [
      ["resume", "Resume goal"],
      ["clear", "Clear goal"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = t(labelKey);
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
function threadError(thread) {
  if (!thread?.id) return null;
  if (sessionHasActiveLatestTurn(thread) || sessionHasSuccessfulLatestTurn(thread)) return null;
  const tracked = threadErrors.get(thread.id),
    status = thread.status;
  const value =
    tracked ||
    thread.error ||
    thread.failure ||
    thread.lastError ||
    status?.error ||
    status?.failure ||
    (errorStatus(status) ? status : null);
  if (!value) return null;
  return { message: errorMessage(value) || t("Task failed"), turnId: tracked?.turnId || thread.lastError?.turnId };
}
function sessionStatusError(thread) {
  if (!thread?.id) return null;
  if (sessionHasActiveLatestTurn(thread) || sessionHasSuccessfulLatestTurn(thread)) return null;
  const tracked = threadErrors.get(thread.id),
    status = thread.status,
    turn = thread.turns?.at(-1);
  const value =
    tracked ||
    turn?.error ||
    turn?.failure ||
    thread.error ||
    thread.failure ||
    thread.lastError ||
    status?.error ||
    status?.failure ||
    (errorStatus(status) ? status : null);
  return value
    ? { message: errorMessage(value) || t("Task failed"), turnId: tracked?.turnId || thread.lastError?.turnId }
    : null;
}
function deriveSessionStatus(thread = state.active) {
  if (!thread?.id) return null;
  const error = sessionStatusError(thread),
    turn = thread.turns?.at(-1),
    turnStatus = latestSessionTurnStatus(thread),
    threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
  if (error)
    return {
      state: "error",
      label: t("Task failed"),
      detail: error.message === t("Task failed") ? "" : error.message,
      icon: "triangleAlert",
    };
  if (sessionHasActiveLatestTurn(thread))
    return { state: "running", label: t("In progress"), detail: "", icon: "loaderCircle" };
  if (["completed", "interrupted", "cancelled", "canceled"].includes(turnStatus))
    return {
      state: "completed",
      label: turnStatus === "completed" ? t("Completed") : t("Stopped"),
      detail: "",
      icon: "check",
    };
  if (["failed", "error", "errored"].includes(turnStatus))
    return { state: "error", label: t("Task failed"), detail: "", icon: "triangleAlert" };
  if (thread === state.active && activeTurnId())
    return { state: "running", label: t("In progress"), detail: "", icon: "loaderCircle" };
  if (threadStatus === "active") return { state: "running", label: t("In progress"), detail: "", icon: "loaderCircle" };
  if (!turn) return { state: "idle", label: t("Not started"), detail: "", icon: "info" };
  return { state: "syncing", label: t("Status syncing…"), detail: "", icon: "loaderCircle" };
}
function syncSessionStatusSurface() {
  workbench?.refresh();
  const root = $("#sessionStatus");
  if (!root) return;
  const status = deriveSessionStatus();
  if (!status) {
    root.hidden = true;
    root.replaceChildren();
    root.removeAttribute("data-state");
    return;
  }
  root.hidden = false;
  root.dataset.state = status.state;
  root.setAttribute(
    "aria-label",
    `${t("Session status")}: ${status.label}${status.detail ? ` — ${status.detail}` : ""}`,
  );
  root.title = status.detail || status.label;
  root.innerHTML = `<span class="session-status-icon" aria-hidden="true">${codexIcon(status.icon)}</span><span class="session-status-copy">${escapeHtml(status.label)}</span>${status.detail ? `<span class="session-status-detail">${escapeHtml(status.detail)}</span>` : ""}`;
}
function rememberThreadError(threadId, value, turnId) {
  if (!threadId) return;
  const message = errorMessage(value) || t("Task failed");
  const details = { message, turnId };
  threadErrors.set(threadId, details);
  for (const thread of [
    state.threads.find((item) => item.id === threadId),
    state.active?.id === threadId ? state.active : null,
  ])
    if (thread) thread.error = details;
  refreshThreadRowMetadata();
  if (state.active?.id === threadId) {
    syncSessionStatusSurface();
    syncThreadErrorSurface(threadId);
  }
}
function clearThreadError(threadId) {
  if (!threadId) return;
  threadErrors.delete(threadId);
  for (const thread of [
    state.threads.find((item) => item.id === threadId),
    state.active?.id === threadId ? state.active : null,
  ])
    if (thread) {
      delete thread.error;
      delete thread.failure;
      delete thread.lastError;
    }
  refreshThreadRowMetadata();
  if (state.active?.id === threadId) {
    syncSessionStatusSurface();
    syncThreadErrorSurface(threadId);
  }
}
function syncThreadTurnError(threadId, turn) {
  if (!threadId || !turn) return;
  if (turn.id && threadRunningTurns.has(threadId) && threadRunningTurns.get(threadId) !== turn.id) return;
  if (turn.status === "inProgress") {
    clearThreadError(threadId);
    return;
  }
  if (errorStatus(turn.status) || turn.error || turn.failure)
    rememberThreadError(threadId, turn.error || turn.failure, turn.id);
  else if (turn.status === "completed") clearThreadError(threadId);
}
function syncThreadErrorsFromTurns(threadId, turns = []) {
  const turn = turns.at(-1);
  if (!turn) return;
  if (turn.status === "inProgress") {
    clearThreadError(threadId);
    return;
  }
  if (errorStatus(turn.status) || turn.error || turn.failure)
    rememberThreadError(threadId, turn.error || turn.failure || turn.status, turn.id);
  else if (turn.status === "completed") clearThreadError(threadId);
}
function syncThreadErrorSurface(threadId = state.active?.id) {
  if (!threadId || threadId !== state.active?.id) return;
  const root = $("#conversation");
  if (!root) return;
  root.querySelector("[data-thread-error]")?.remove();
  const error = threadError(state.active);
  if (!error) return;
  const card = document.createElement("section");
  card.className = "thread-error-banner";
  card.dataset.threadError = "true";
  card.setAttribute("role", "alert");
  const heading = document.createElement("strong");
  heading.textContent = t("Task failed");
  const message = document.createElement("p");
  message.textContent = error.message;
  card.append(heading, message);
  root.prepend(card);
}
function rememberSummaryErrors(threads) {
  for (const thread of threads) {
    if (sessionHasActiveLatestTurn(thread) || sessionHasSuccessfulLatestTurn(thread)) {
      threadErrors.delete(thread.id);
      delete thread.error;
      delete thread.failure;
      delete thread.lastError;
      continue;
    }
    const status = thread.status;
    const value =
      thread.error ||
      thread.failure ||
      thread.lastError ||
      status?.error ||
      status?.failure ||
      (errorStatus(status) ? status : null);
    if (value) threadErrors.set(thread.id, { message: errorMessage(value) || t("Task failed"), turnId: value?.turnId });
  }
}
function updateThreadRowMeta(row, thread, meta = row.querySelector(".thread-meta")) {
  if (!meta) return;
  const error = threadError(thread),
    running = !error && sessionHasActiveLatestTurn(thread),
    spinner = row.querySelector(".thread-running"),
    time = meta.querySelector("time"),
    timestamp = threadLastActivityAt(thread);
  row.dataset.running = String(running);
  row.dataset.error = String(Boolean(error));
  row.classList.toggle("error", Boolean(error));
  spinner.hidden = !running;
  spinner.title = t("In progress");
  spinner.setAttribute("aria-label", t("In progress"));
  time.textContent = timestamp ? formatActivityAge(timestamp, { locale: i18n.locale }) : "—";
  const label = timestamp ? t("Last activity: {time}", { time: time.textContent }) : t("Activity time unavailable");
  const errorLabel = error ? t("Task failed: {message}", { message: error.message }) : "";
  time.title = errorLabel || label;
  time.setAttribute("aria-label", errorLabel || label);
  if (timestamp) time.dateTime = new Date(timestamp * 1000).toISOString();
  else time.removeAttribute("datetime");
  row.title = [titleOf(thread), shortPath(thread.cwd), running ? t("In progress") : "", errorLabel, label]
    .filter(Boolean)
    .join(" — ");
}
function refreshThreadRowMetadata() {
  workbench?.refresh();
  for (const row of $("#threadList").querySelectorAll(".thread-item")) {
    const thread = state.threads.find((thread) => thread.id === row.dataset.id);
    if (thread) updateThreadRowMeta(row, thread);
  }
}
function syncConversationLoadingSurface(loading) {
  const root = $("#conversation");
  if (!root) return;
  const existing = root.querySelector("[data-conversation-loading]");
  if (!loading) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const notice = document.createElement("div");
  notice.className = "conversation-loading-notice";
  notice.dataset.conversationLoading = "true";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.innerHTML = '<span class="conversation-loading-spinner" aria-hidden="true"></span><span></span>';
  notice.lastElementChild.textContent = t("Loading conversation…");
  root.prepend(notice);
}
let conversationResyncInFlight = false,
  conversationResyncLastAt = 0;
async function resyncActiveConversation() {
  const threadId = state.active?.id;
  if (!threadId || conversationResyncInFlight || Date.now() - conversationResyncLastAt < 10000) return false;
  conversationResyncInFlight = true;
  conversationResyncLastAt = Date.now();
  const generation = threadNavigationGeneration;
  syncConversationLoadingSurface(true);
  const notice = $("#conversation").querySelector("[data-conversation-loading]");
  if (notice?.lastElementChild) notice.lastElementChild.textContent = t("Refreshing conversation…");
  try {
    const thread = await readConversation(threadId, state.active, { getCurrent: () => state.active });
    if (generation !== threadNavigationGeneration || state.active?.id !== threadId) return false;
    if (!thread) throw new Error(t("Could not refresh conversation"));
    state.active = thread;
    conversationCache.set(threadId, thread);
    persistedConversationVersions.set(threadId, thread.history?.revision);
    cacheConversation(thread);
    renderHeader();
    renderThread(thread);
    renderThreads();
    toast(t("Conversation resynchronized"));
    return true;
  } catch (error) {
    console.warn("[panda-force] conversation resync failed:", error);
    addPersistentError(error?.message || t("Could not refresh conversation"));
    return false;
  } finally {
    conversationResyncInFlight = false;
    if (state.active?.id === threadId) syncConversationLoadingSurface(false);
  }
}
function updateThreadListActivity(threadId, { status, turnId, turnStatus, completed = false, timestamp } = {}) {
  if (!threadId) return;
  if (completed && turnId && threadRunningTurns.has(threadId) && threadRunningTurns.get(threadId) !== turnId) return;
  if (turnId && turnStatus) {
    const thread =
      state.active?.id === threadId ? state.active : state.threads.find((thread) => thread.id === threadId);
    threadRuntimeTurns.set(threadId, { id: turnId, status: turnStatus, historyTailId: thread?.turns?.at(-1)?.id });
  }
  if (status?.type === "active" && turnId) threadRunningTurns.set(threadId, turnId);
  else if (status && status.type !== "active") {
    threadRunningTurns.delete(threadId);
    const runtime = threadRuntimeTurns.get(threadId);
    if (runtime?.status === "inProgress") threadRuntimeTurns.set(threadId, { ...runtime, status: "idle" });
  }
  for (const thread of [
    state.threads.find((thread) => thread.id === threadId),
    state.active?.id === threadId ? state.active : null,
  ]) {
    if (!thread) continue;
    if (status) thread.status = status;
    if (timestamp) thread.lastActivityAt = Math.max(threadLastActivityAt(thread), timestamp);
  }
  refreshThreadRowMetadata();
  if (state.active?.id === threadId) syncSessionStatusSurface();
}
async function readConversation(id, previous, { limit = BACKGROUND_CONVERSATION_HISTORY_LIMIT, getCurrent } = {}) {
  try {
    const response = await rpc("host/thread/history", {
      threadId: id,
      revision: previous?.history?.revision,
      oldestItemId: previous?.history?.oldestItemId,
      limit,
    });
    if (response.history) {
      // A load-older request may finish while this refresh is in flight. Merge
      // against the current view so the older page is not overwritten.
      const current = getCurrent?.();
      const thread = mergeConversationHistory(current?.id === id ? current : previous, response);
      thread.history.reset = response.history.mode === "snapshot";
      thread.history.removedItems = Boolean(response.history.removedItemIds?.length);
      thread.history.unchanged =
        response.history.mode === "delta" &&
        !response.history.removedItemIds?.length &&
        !response.history.questionTurns?.some((turn) => turn.items?.length) &&
        !response.history.turns.length;
      return thread;
    }
  } catch (error) {
    if (!/not available|unknown|unsupported|method not found/i.test(error?.message || "")) throw error;
  }
  const result = await rpc("thread/read", { threadId: id, includeTurns: true });
  return { ...previous, ...result.thread };
}
function conversationItemCount(thread) {
  return (thread?.turns || []).reduce((count, turn) => count + (turn.items || []).length, 0);
}
async function prefetchEarlierConversation(thread, navigationId) {
  const id = thread?.id,
    cursor = thread?.history?.nextCursor;
  if (!id || !cursor || !threadNavigationGate.isCurrent(navigationId)) return;
  try {
    const result = await rpc("host/thread/history", {
      threadId: id,
      cursor,
      limit: BACKGROUND_CONVERSATION_HISTORY_LIMIT,
    });
    if (
      !threadNavigationGate.isCurrent(navigationId) ||
      state.active?.id !== id ||
      state.active.history?.nextCursor !== cursor
    )
      return;
    const merged = mergeConversationHistory(state.active, result, { page: true });
    state.active = merged;
    cacheConversation(merged);
  } catch (error) {
    // Background history is an enhancement. The latest page is already usable;
    // leave the existing load-older control to retry the request on demand.
    console.warn("[panda-force] background conversation history failed:", error?.message || error);
  }
}
async function loadEarlierConversation(thread) {
  const current = state.active?.id === thread.id ? state.active : thread;
  const id = current.id,
    generation = threadNavigationGeneration,
    root = $("#conversation"),
    height = root.scrollHeight,
    top = root.scrollTop;
  const result = await rpc("host/thread/history", {
    threadId: id,
    cursor: current.history.nextCursor,
    limit: BACKGROUND_CONVERSATION_HISTORY_LIMIT,
  });
  if (generation !== threadNavigationGeneration || state.active?.id !== id) return;
  const merged = mergeConversationHistory(state.active, result, { page: true });
  state.active = merged;
  cacheConversation(merged);
  state.turnWindow = null;
  renderThread(merged, merged.turns.length);
  root.scrollTop = top + root.scrollHeight - height;
}
function showOpenedConversation(thread, fromCache = false) {
  conversationAutoScroll = true;
  syncConversationScrollSurface();
  resetActiveThreadSync();
  setActiveTurnId("");
  state.active = thread;
  rememberActiveThread(thread.id);
  if (state.sessionSettings.has(thread.id)) applySessionSettings(thread.id, state.sessionSettings.get(thread.id));
  restoreComposerDraft();
  state.turnWindow = null;
  clearConversationRuntime();
  state.changes.clear();
  resetReviewState();
  closeComposerAutocomplete();
  renderContextTray();
  renderContextUsage();
  renderHeader();
  renderThreads();
  syncSessionStatusSurface();
  if (thread.turns?.length) {
    renderThread(thread);
    syncTurnRuntime(thread.turns.at(-1));
    scrollOpenedThreadToBottom();
  } else {
    $("#conversation").innerHTML =
      `<div class="list-state conversation-loading">${fromCache ? "No conversation history loaded. Send a message to continue." : "Loading conversation…"}</div>`;
    syncThreadErrorSurface(thread.id);
    renderPendingUserMessages();
  }
  syncConversationLoadingSurface(fromCache);
}

function startupThreadAllowed(id) {
  return Boolean(id) && (location.pathname === "/" || (workbench?.route.page === "task" && workbench.route.id === id));
}
async function restoreCachedStartup(id, current) {
  const generation = threadNavigationGeneration;
  // Restore the small sidebar before reading/deserializing a conversation.
  void persistentConversationCache.summaries().then((summaries) => {
    if (
      current() &&
      generation === threadNavigationGeneration &&
      !cachedSidebar &&
      !threadListHasFreshData &&
      !state.threads.length &&
      summaries?.length
    ) {
      state.threads = summaries;
      renderThreads();
    }
  });
  const thread = startupThreadAllowed(id) ? await persistentConversationCache.get(id) : null;
  if (!current() || generation !== threadNavigationGeneration || state.active) return;
  if (!thread) return;
  await initialConfigReady;
  if (
    !current() ||
    generation !== threadNavigationGeneration ||
    state.active ||
    id !== storage.get(STORAGE_KEYS.activeThread)
  )
    return;
  conversationCache.set(id, thread);
  persistedConversationVersions.set(id, thread.history?.revision);
  showOpenedConversation(thread, true);
  if (state.connected) scheduleActiveThreadSync(0);
}
async function openThread(id, fallbackSummary = null) {
  workbench?.threadOpened(id);
  saveComposerDraft();
  pruneConversationCaches();
  if (state.active?.turns?.length || conversationCache.has(state.active?.id)) cacheConversation(state.active);
  const navigationId = threadNavigationGate.next();
  threadNavigationGeneration++;
  const persisted = conversationCache.has(id) ? null : await persistentConversationCache.get(id);
  if (!threadNavigationGate.isCurrent(navigationId)) return false;
  if (persisted) conversationCache.set(id, persisted);
  const listedSummary = state.threads.find((x) => x.id === id),
    cached = conversationCache.get(id),
    summary = listedSummary || fallbackSummary || cached,
    deferTransition = Boolean(fallbackSummary && !listedSummary && !cached);
  const showThread = (thread) => showOpenedConversation(thread, Boolean(cached));
  if (!deferTransition) {
    resetActiveThreadSync();
    setActiveTurnId("");
    rememberActiveThread(id);
    if (summary) showThread(cached ? { ...summary, ...cached } : summary);
  }
  try {
    const thread = await readConversation(id, cached || summary, {
      limit: cached ? BACKGROUND_CONVERSATION_HISTORY_LIMIT : INITIAL_CONVERSATION_HISTORY_LIMIT,
    });
    if (!threadNavigationGate.isCurrent(navigationId)) return false;
    if (state.active?.id === id) saveComposerDraft();
    cacheConversation(thread);
    if (cached && state.active?.id === id && thread.history?.unchanged) {
      state.active = thread;
      renderHeader();
      syncTurnRuntime(thread.turns.at(-1));
    } else showThread(thread);
    syncConversationLoadingSurface(false);
    if (!thread.turns?.length) {
      $("#conversation").innerHTML =
        '<div class="list-state conversation-loading">No conversation history loaded. Send a message to continue.</div>';
      syncThreadErrorSurface(thread.id);
      renderPendingUserMessages();
    }
    refreshMessageQueue(id);
    restorePendingApprovals();
    // Let the latest messages paint before requesting a larger older page.
    const shouldPrefetch =
      thread.history?.nextCursor && conversationItemCount(thread) < BACKGROUND_CONVERSATION_HISTORY_LIMIT;
    if (shouldPrefetch)
      requestAnimationFrame(() => requestAnimationFrame(() => void prefetchEarlierConversation(thread, navigationId)));
    scheduleActiveThreadSync(shouldPrefetch ? ACTIVE_THREAD_SYNC_IDLE_MS : 0);
    return true;
  } catch (error) {
    if (!threadNavigationGate.isCurrent(navigationId)) return false;
    if (cached) {
      syncConversationLoadingSurface(false);
      restorePendingApprovals();
      scheduleActiveThreadSync(0);
      return false;
    }
    if (deferTransition) {
      addPersistentError(error?.message || "Could not load side task");
      return false;
    }
    if (!summary || state.active?.id !== id) return false;
    $("#conversation").innerHTML =
      '<div class="list-state conversation-loading">Could not load history. Send a message to start fresh.</div>';
    syncThreadErrorSurface(id);
    syncConversationLoadingSurface(false);
    renderPendingUserMessages();
    return false;
  }
}

function renderHeader() {
  workbench?.refresh();
  if ($("#goalDialog").open && goalDialogThreadId !== state.active?.id) closeGoalDialog();
  renderMessageQueue();
  const t = state.active;
  if (!t) {
    syncGoalStatusSurface();
    syncSessionStatusSurface();
    return;
  }
  $("#threadTitle").textContent = titleOf(t);
  if (t.projectless) {
    state.projectless = true;
    state.workspaceContext = null;
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
  syncGoalStatusSurface();
  syncSessionStatusSurface();
}
function renderThread(thread, loadMore = 0) {
  const root = $("#conversation"),
    turns = thread.turns || [];
  syncThreadErrorsFromTurns(thread.id, turns);
  state.turnWindow = createTurnWindow(
    turns,
    DEFAULT_TURN_PAGE_SIZE,
    state.turnWindow?.threadId === thread.id ? state.turnWindow.start : undefined,
    loadMore,
  );
  state.turnWindow.threadId = thread.id;
  clearConversationRuntime();
  root.innerHTML = "";
  syncThreadErrorSurface(thread.id);
  if (state.turnWindow.hiddenCount || thread.history?.nextCursor) {
    const more = document.createElement("button");
    more.className = "load-older";
    more.textContent = state.turnWindow.hiddenCount
      ? `Load earlier messages (${state.turnWindow.hiddenCount})`
      : t("Load earlier messages");
    more.onclick = async () => {
      const current = state.active?.id === thread.id ? state.active : thread;
      if (state.turnWindow.hiddenCount) {
        renderThread(current, DEFAULT_TURN_PAGE_SIZE);
        return;
      }
      if (conversationItemCount(current) > conversationItemCount(thread)) {
        const height = root.scrollHeight,
          top = root.scrollTop;
        state.turnWindow = null;
        renderThread(current, current.turns.length);
        root.scrollTop = top + root.scrollHeight - height;
        return;
      }
      more.disabled = true;
      try {
        await loadEarlierConversation(current);
      } catch (error) {
        if (await resyncActiveConversation()) return;
        addPersistentError(error.message);
        more.disabled = false;
      }
    };
    root.append(more);
  }
  for (const turn of state.turnWindow.visible) renderTurn(turn, root);
  restorePendingApprovals();
  renderPendingUserMessages();
  if (!root.children.length) showEmpty();
  else if (!loadMore) scrollBottom();
}
function showEmpty() {
  renderMessageQueue();
  const root = $("#conversation");
  root.innerHTML = `<div class="empty-state" id="emptyState">${pandaInterfaceMark("empty-panda-mark")}<h1>${escapeHtml(t("What can I help?"))}</h1></div>`;
  renderPendingUserMessages();
  restorePendingApprovals();
}
function ensureTurnTimeline(turnId, root = $("#conversation")) {
  let turn = state.turns.get(turnId);
  if (turn?.isConnected) return turn;
  turn = document.createElement("article");
  turn.className = "turn assistant-turn native-turn-timeline";
  turn.dataset.turnId = turnId;
  turn.innerHTML =
    '<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="worked-for-divider" data-worked-for-divider hidden><span>Worked</span><div></div></div><div class="turn-final-slot"></div>';
  root.append(turn);
  state.turns.set(turnId, turn);
  state.dividers.set(turnId, turn.querySelector("[data-worked-for-divider]"));
  const timing = state.turnTimings.get(turnId);
  if (timing) {
    if (timing.started) turn.dataset.turnStartedAt = String(timing.started);
    if (timing.completed) turn.dataset.turnCompletedAt = String(timing.completed);
  }
  return turn;
}
function timestampSeconds(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value)) value = Date.parse(value);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 1e12 ? number / 1000 : number;
}
function messageClock(timestamp) {
  const seconds = timestampSeconds(timestamp);
  if (!seconds) return null;
  return new Intl.DateTimeFormat(i18n.locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(seconds * 1000));
}
function recordTurnTiming(turnId, turn = {}) {
  if (!turnId) return;
  const timing = state.turnTimings.get(turnId) || {};
  const started = timestampSeconds(turn.startedAt ?? turn.startedAtMs),
    completed = timestampSeconds(turn.completedAt ?? turn.completedAtMs);
  if (started) timing.started = started;
  if (completed) timing.completed = completed;
  state.turnTimings.set(turnId, timing);
  const timeline = state.turns.get(turnId);
  if (!timeline) return;
  if (timing.started) timeline.dataset.turnStartedAt = String(timing.started);
  if (timing.completed) timeline.dataset.turnCompletedAt = String(timing.completed);
}
function setMessageTime(el, timestamp, label) {
  const clock = messageClock(timestamp);
  if (!el || !clock) return;
  el.dataset.messageTime = clock;
  el.title = t(label, { time: clock });
  el.setAttribute("aria-label", t(label, { time: clock }));
}
function formatWorkedDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
function turnDurationMs(turn = {}) {
  if (Number.isFinite(turn.durationMs)) return turn.durationMs;
  if (Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt))
    return Math.max(0, (turn.completedAt - turn.startedAt) * 1000);
  if (Number.isFinite(turn.startedAtMs) && Number.isFinite(turn.completedAtMs))
    return Math.max(0, turn.completedAtMs - turn.startedAtMs);
  return undefined;
}
function syncWorkedForDivider(turnId, durationMs) {
  if (renderingTurn) return;
  const turn = state.turns.get(turnId),
    divider = state.dividers.get(turnId);
  if (!turn || !divider) return;
  if (Number.isFinite(durationMs)) turn.dataset.durationMs = String(durationMs);
  const hasActivity = Boolean(turn.querySelector("[data-agent-activity-group]")),
    hasFinal = Boolean(turn.querySelector("[data-local-conversation-final-assistant]"));
  divider.hidden = !(hasActivity && hasFinal);
  const duration = formatWorkedDuration(Number(turn.dataset.durationMs));
  divider.querySelector("span").textContent = duration ? `Worked for ${duration}` : "Worked";
}
function releasePromptSubmission(token) {
  if (token) for (const [key, value] of promptSubmissions) if (value === token) promptSubmissions.delete(key);
  syncComposerSubmitState();
}
function pendingMessageOwner() {
  return state.active?.id || `new:${threadNavigationGeneration}`;
}
function renderPendingUserMessages() {
  for (const message of pendingUserMessages.values())
    if (message.owner === pendingMessageOwner()) upsertItem(message, message.turnId, $("#conversation"), false);
}
function setPendingMessageDelivery(id, delivery) {
  const message = pendingUserMessages.get(id);
  if (!message) return;
  message.delivery = delivery;
  if (message.owner === pendingMessageOwner()) upsertItem(message, message.turnId);
}
function renderTurn(turn, root = $("#conversation")) {
  recordTurnTiming(turn.id, turn);
  let userSeen = false;
  renderingTurn = true;
  try {
    for (const item of turn.items || []) {
      upsertItem(item.type === "userMessage" ? { ...item, steer: item.steer || userSeen } : item, turn.id, root, false);
      if (item.type === "userMessage") userSeen = true;
    }
  } finally {
    renderingTurn = false;
    for (const activity of pendingActivitySummaries) updateActivitySummary(activity);
    pendingActivitySummaries.clear();
    if (pendingTurnReview) {
      pendingTurnReview = false;
      syncTurnReviewFromItems(turn.id);
    }
    if (pendingChangesRender) {
      pendingChangesRender = false;
      renderChanges();
    }
    if (pendingSideTasksRender) {
      pendingSideTasksRender = false;
      renderSideTasks();
    }
    syncWorkedForDivider(turn.id, turnDurationMs(turn));
  }
}
function textFromInput(content = []) {
  return content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");
}
function claimOptimisticUser(item, root, turnId) {
  if (String(item.id).startsWith("local-")) return null;
  const text = textFromInput(item.content),
    message = [...pendingUserMessages.values()].find(
      (message) =>
        message.owner === pendingMessageOwner() &&
        message.delivery !== "failed" &&
        (item.clientId
          ? item.clientId === message.id
          : composerInputKey(message.content) === composerInputKey(item.content)) &&
        !message.excludedTurns.includes(turnId) &&
        (message.turnId === "optimistic" || message.turnId === turnId),
    );
  let el = message && state.items.get(message.id);
  if (message) {
    releasePromptSubmission(message.submissionToken);
    pendingUserMessages.delete(message.id);
    if (!el?.isConnected) {
      upsertItem({ ...message, delivery: "sent" }, turnId, root, false);
      el = state.items.get(message.id);
    }
  }
  if (!el) {
    const candidates = [...root.querySelectorAll('.user-turn[data-optimistic-user="true"]')];
    el = candidates.find((node) => {
      const pending = [...pendingUserMessages.values()].find((message) => state.items.get(message.id) === node);
      return (
        !pending &&
        (node.dataset.steer !== "true" || node.dataset.userTurnId === turnId) &&
        node.dataset.inputKey === composerInputKey(item.content)
      );
    });
  }
  if (!el) return null;
  for (const [id, node] of state.items) if (node === el) state.items.delete(id);
  delete el.dataset.optimisticUser;
  state.items.set(item.id, el);
  return el;
}
function userMessageIdFamily(id) {
  return String(id).startsWith("local-") ? "local" : String(id).startsWith("host-user-") ? "rollout" : "app";
}
function claimEquivalentUserMessage(item, root, turnId) {
  const family = userMessageIdFamily(item.id),
    text = textFromInput(item.content);
  if (family === "local") return null;
  for (const [id, node] of state.items) {
    if (
      userMessageIdFamily(id) === "local" ||
      userMessageIdFamily(id) === family ||
      !root.contains(node) ||
      node.dataset.userTurnId !== turnId ||
      (item.clientId
        ? node.dataset.clientId !== item.clientId
        : node.dataset.inputKey !== composerInputKey(item.content))
    )
      continue;
    // Each source can claim a message once, so repeated identical steers stay distinct.
    if ([...state.items].some(([alias, element]) => element === node && userMessageIdFamily(alias) === family))
      continue;
    state.items.set(item.id, node);
    return node;
  }
  return null;
}
function agentMessageIdFamily(id) {
  const value = String(id || "");
  return /^item[-_]/.test(value) ? "app" : /^(?:msg_|host-message-)/.test(value) ? "rollout" : "";
}
function claimEquivalentAgentMessage(item, turnId) {
  const family = agentMessageIdFamily(item.id);
  if (!family) return null;
  const text = agentMessageText(item, ""),
    commentary = item.phase === "commentary";
  for (const [id, node] of state.items) {
    if (agentMessageIdFamily(id) === family || node.closest("[data-turn-id]")?.dataset.turnId !== turnId) continue;
    const body = node.querySelector(".message-text"),
      existingCommentary = node.dataset.localConversationCommentary !== undefined;
    if (existingCommentary === commentary && body?.dataset.raw === text) {
      state.items.set(item.id, node);
      return node;
    }
  }
  return null;
}
function placeAgentMessage(el, item, timeline) {
  const commentary = item.phase === "commentary",
    slot = timeline.querySelector(commentary ? ".turn-event-stream" : ".turn-final-slot");
  el.className = commentary ? "assistant-response assistant-commentary" : "assistant-response";
  if (commentary) {
    delete el.dataset.localConversationFinalAssistant;
    el.dataset.localConversationCommentary = "";
  } else {
    delete el.dataset.localConversationCommentary;
    el.dataset.localConversationFinalAssistant = "";
  }
  if (el.parentElement !== slot) slot.append(el);
}
function imageCwd(item = {}) {
  return item.cwd || state.active?.cwd || state.config.defaultCwd || ".";
}
async function copyMessageText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  // LAN HTTP pages may not expose the Clipboard API.
  const active = document.activeElement,
    selection = document.getSelection(),
    ranges = [];
  if (selection)
    for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    field.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
async function copyUserMessage(button) {
  const text = button.closest(".user-turn")?.querySelector(".user-message")?.textContent;
  if (!text || button.copyPending) return;
  button.copyPending = true;
  button.setAttribute("aria-busy", "true");
  clearTimeout(button.copyResetTimer);
  try {
    await copyMessageText(text);
    button.innerHTML = `${codexIcon("check")}<span>Copied</span>`;
    button.setAttribute("aria-label", "Copied");
    button.title = "Copied";
    toast(t("Copied"));
    button.copyResetTimer = setTimeout(() => {
      button.innerHTML = `${codexIcon("copy")}<span>Copy</span>`;
      button.setAttribute("aria-label", "Copy message");
      button.title = "Copy message";
    }, 2000);
  } catch {
    addPersistentError(t("Copy failed. Please select and copy the message manually."));
  } finally {
    button.copyPending = false;
    button.removeAttribute("aria-busy");
  }
}
function fileReferenceCopyText(anchor) {
  const path = anchor?.dataset?.fileReference;
  if (!path) return "";
  const start = Number(anchor.dataset.fileLineStart) || null,
    end = Number(anchor.dataset.fileLineEnd) || null;
  const suffix = start == null ? "" : `:${start}${end == null ? "" : `-${end}`}`;
  const label = anchor.textContent?.trim() || path;
  return `${label} (${path}${suffix})`;
}
function fileReferenceClipboardUrl(anchor) {
  const path = anchor?.dataset?.fileReference;
  if (!path) return "";
  const start = Number(anchor.dataset.fileLineStart) || null,
    end = Number(anchor.dataset.fileLineEnd) || null;
  const suffix = start == null ? "" : `:${start}${end == null ? "" : `-${end}`}`;
  const normalized = String(path).replaceAll("\\", "/");
  const encoded = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F");
  return /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}${suffix}` : `file://${encoded}${suffix}`;
}
function copyConversationFileReferences(event) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData || !selection.rangeCount) return;
  const range = selection.getRangeAt(0),
    start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement,
    end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const root = start?.closest(".message-text");
  if (!root || root !== end?.closest(".message-text")) return;
  const fragment = range.cloneContents(),
    citations = [...(fragment.querySelectorAll?.("a[data-file-reference]") || [])];
  if (!citations.length) return;
  for (const citation of citations) {
    const text = document.createTextNode(fileReferenceCopyText(citation));
    citation.replaceWith(text);
  }
  const textHolder = document.createElement("div");
  textHolder.append(fragment);
  const htmlFragment = range.cloneContents(),
    htmlCitations = [...(htmlFragment.querySelectorAll?.("a[data-file-reference]") || [])];
  for (const citation of htmlCitations) {
    citation.setAttribute("href", fileReferenceClipboardUrl(citation));
    citation.removeAttribute("data-file-reference");
    citation.removeAttribute("data-file-cwd");
  }
  const htmlHolder = document.createElement("div");
  htmlHolder.append(htmlFragment);
  event.clipboardData.setData("text/plain", textHolder.textContent || "");
  event.clipboardData.setData("text/html", htmlHolder.innerHTML);
  event.preventDefault();
}
function sideTaskStatus(item, threadId) {
  const agent = item.agentsStates?.[threadId];
  if (agent?.status) return agent.status;
  if (item.type === "subAgentActivity") return item.kind === "interrupted" ? "interrupted" : "running";
  return item.status === "failed" ? "errored" : item.status === "completed" ? "completed" : "running";
}
function updateSideTasks(item) {
  if (item.type === "collabAgentToolCall") {
    for (const threadId of item.receiverThreadIds || []) {
      const previous = state.sideTasks.get(threadId) || {};
      state.sideTasks.set(threadId, {
        ...previous,
        threadId,
        prompt: item.prompt || previous.prompt || "",
        model: item.model || previous.model || "",
        reasoningEffort: item.reasoningEffort || previous.reasoningEffort || "",
        status: sideTaskStatus(item, threadId),
        message: item.agentsStates?.[threadId]?.message || previous.message || "",
      });
    }
  } else if (item.type === "subAgentActivity") {
    const previous = state.sideTasks.get(item.agentThreadId) || {};
    state.sideTasks.set(item.agentThreadId, {
      ...previous,
      threadId: item.agentThreadId,
      agentPath: item.agentPath || previous.agentPath || "",
      status: sideTaskStatus(item, item.agentThreadId),
    });
  }
  renderSideTasks();
}
function renderSideTasks() {
  if (renderingTurn) {
    pendingSideTasksRender = true;
    return;
  }
  const list = $("#sideTaskList");
  if (!list) return;
  list.innerHTML = "";
  for (const task of state.sideTasks.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "side-task-card";
    button.dataset.threadId = task.threadId;
    button.innerHTML = `${codexIcon("messageSquare")}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath || task.model || "Side task")}</strong><small>${escapeHtml(task.message || task.prompt || task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status || "running")}">${escapeHtml(task.status || "running")}</span>`;
    button.onclick = async () => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      await openThread(task.threadId, {
        id: task.threadId,
        name: task.agentPath || task.model || "Side task",
        preview: task.prompt || task.message || "",
        cwd: state.active?.cwd || state.config.defaultCwd,
        source: "local",
        sideTask: true,
      });
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    };
    list.append(button);
  }
  if (!state.sideTasks.size)
    list.innerHTML = '<div class="side-task-empty">Side tasks started by this chat will appear here.</div>';
  const summary = $("#summarySideTasks");
  if (summary)
    summary.textContent = state.sideTasks.size
      ? `${state.sideTasks.size} side task${state.sideTasks.size === 1 ? "" : "s"}`
      : "No side tasks";
}
function upsertItem(item, turnId, root = $("#conversation"), live = true) {
  root.querySelector("#emptyState")?.remove();
  let el = state.items.get(item.id);
  if (el && !root.contains(el)) {
    state.items.delete(item.id);
    el = null;
  }
  if (!el && item.type === "userMessage") closeEarlierAsyncQuestions(root, t);
  if (!el && item.type === "userMessage")
    el = claimOptimisticUser(item, root, turnId) || claimEquivalentUserMessage(item, root, turnId);
  if (!el && item.type === "agentMessage") el = claimEquivalentAgentMessage(item, turnId);
  const questions = readAsyncQuestions(item);
  if (questions) {
    if (!el) {
      // Arguments can arrive after the generic tool row; replace that row once.
      const oldRow = root.querySelector(`[data-item-id="${CSS.escape(activityItemId(item))}"].activity-item`);
      if (oldRow) {
        const group = oldRow.closest("[data-agent-activity-group]");
        oldRow.nextElementSibling?.remove();
        oldRow.remove();
        state.activityItems.get(turnId)?.delete(activityItemId(item));
        if (group?.querySelector(".activity-item")) updateActivitySummary(group);
        else group?.remove();
      }
      const questionThreadId = state.active?.id;
      el = createAsyncQuestionCard(item, questions, {
        t,
        sendAnswer: (answer) => submitPrompt({ preventDefault() {} }, { text: answer, threadId: questionThreadId }),
      });
      ensureTurnTimeline(turnId, root).querySelector(".turn-event-stream").append(el);
      state.items.set(item.id, el);
    }
    return;
  }
  if (!el) {
    if (item.type === "userMessage") {
      el = document.createElement("article");
      el.className = "turn user-turn";
      el.dataset.userTurnId = turnId;
      if (String(item.id).startsWith("local-")) el.dataset.optimisticUser = "true";
      el.innerHTML = '<div class="user-message"></div>';
      const steer =
        item.steer ?? Boolean(root.querySelector(`.user-turn[data-user-turn-id="${CSS.escape(String(turnId))}"]`));
      if (steer) {
        el.dataset.steer = "true";
        ensureTurnTimeline(turnId, root).querySelector(".turn-event-stream").append(el);
      } else {
        const timeline = state.turns.get(turnId);
        timeline?.isConnected ? root.insertBefore(el, timeline) : root.append(el);
      }
    } else if (item.type === "agentMessage") {
      const timeline = ensureTurnTimeline(turnId, root);
      el = document.createElement("div");
      el.innerHTML = '<div class="message-text"></div>';
      placeAgentMessage(el, item, timeline);
    } else if (item.type === "imageGeneration") {
      const timeline = ensureTurnTimeline(turnId, root);
      el = document.createElement("div");
      el.className = "assistant-generated-image";
      timeline.querySelector(".turn-event-stream").append(el);
    } else if (
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "dynamicToolCall",
        "collabAgentToolCall",
        "subAgentActivity",
        "webSearch",
        "reasoning",
        "plan",
        "imageView",
      ].includes(item.type)
    ) {
      const id = activityItemId(item);
      el = ensureActivity(turnId, root, id, item.type === "imageView" || item.type === "reasoning");
      addActivity(item, el, id);
    } else return;
    if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "imageGeneration")
      state.items.set(item.id, el);
  }
  if (item.type === "userMessage") {
    settleQueuedMessage(item, turnId);
    el.dataset.userTurnId = turnId;
    el.dataset.inputKey = composerInputKey(item.content);
    if (item.clientId) el.dataset.clientId = item.clientId;
    const userTimeline = state.turns.get(turnId),
      userTiming = state.turnTimings.get(turnId),
      userTimestamp =
        item.sentAt ??
        item.createdAt ??
        item.createdAtMs ??
        userTimeline?.dataset.turnStartedAt ??
        userTiming?.started ??
        el.dataset.messageTimestamp ??
        Date.now() / 1000;
    el.dataset.messageTimestamp = String(timestampSeconds(userTimestamp) || Date.now() / 1000);
    setMessageTime(el, el.dataset.messageTimestamp, "Sent at {time}");
    el.querySelector(".user-message").textContent = composerTextFromInput(item.content);
    let copyButton = el.querySelector(".user-message-copy");
    if (!copyButton) {
      copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "user-message-copy";
      copyButton.setAttribute("aria-label", "Copy message");
      copyButton.title = "Copy message";
      copyButton.innerHTML = `${codexIcon("copy")}<span>Copy</span>`;
      copyButton.onclick = () => copyUserMessage(copyButton);
      el.append(copyButton);
    }
    copyButton.hidden = !el.querySelector(".user-message").textContent;
    const files = attachmentsFromInput(item.content).filter((attachment) => attachment.kind === "file");
    let fileList = el.querySelector(".user-message-files");
    el.classList.toggle("has-files", Boolean(files.length));
    if (files.length) {
      if (!fileList) {
        fileList = document.createElement("div");
        fileList.className = "user-message-files";
        el.querySelector(".user-message").after(fileList);
      }
      fileList.replaceChildren();
      for (const file of files) {
        const link = document.createElement("a");
        if (file.url) {
          link.href = attachmentDisplayUrl(file.url);
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        } else {
          link.href = "#file-reference";
          link.dataset.fileReference = file.path;
          link.dataset.fileCwd = imageCwd(item);
        }
        link.textContent = file.name;
        fileList.append(link);
      }
    } else fileList?.remove();
    let images = el.querySelector(".user-message-images");
    const imageHtml = renderItemImages(item, { cwd: imageCwd(item), className: "message-image-grid" });
    el.classList.toggle("has-images", Boolean(imageHtml));
    if (imageHtml) {
      if (!images) {
        images = document.createElement("div");
        images.className = "user-message-images";
        el.querySelector(".user-message").after(images);
      }
      images.innerHTML = imageHtml;
    } else images?.remove();
    if (item.steer || item.delivery || el.dataset.delivery || el.dataset.steer === "true") {
      if (item.steer) el.dataset.steer = "true";
      el.dataset.delivery =
        item.delivery || (el.dataset.optimisticUser === "true" ? el.dataset.delivery || "sending" : "sent");
      let status = el.querySelector(".steer-message-status");
      if (!status) {
        status = document.createElement("div");
        status.className = "steer-message-status";
        status.setAttribute("role", "status");
        el.prepend(status);
      }
      const label =
        el.dataset.delivery === "sending"
          ? "Sending…"
          : el.dataset.delivery === "failed"
            ? "Send failed"
            : el.dataset.delivery === "unconfirmed"
              ? "Delivery unconfirmed"
              : "Sent";
      status.innerHTML =
        (el.dataset.steer === "true"
          ? `<span>${escapeHtml(t("Steer"))}</span><span aria-hidden="true"> · </span>`
          : "") + `<span>${escapeHtml(t(label))}</span>`;
    }
  }
  if (item.type === "agentMessage") {
    const timeline = ensureTurnTimeline(turnId, root),
      body = el.querySelector(".message-text"),
      text = agentMessageText(item, body.dataset.raw ?? ""),
      cwd = imageCwd(item),
      receivedTimestamp =
        item.receivedAt ??
        item.completedAt ??
        (item.phase === "final_answer" ? timeline.dataset.turnCompletedAt : null) ??
        el.dataset.messageTimestamp ??
        Date.now() / 1000;
    el.dataset.messageTimestamp = String(timestampSeconds(receivedTimestamp) || Date.now() / 1000);
    setMessageTime(el, el.dataset.messageTimestamp, "Received at {time}");
    placeAgentMessage(el, item, timeline);
    body.dataset.raw = text;
    body.innerHTML =
      renderAssistantMarkdown(text, { cwd }) +
      renderItemImages(item, { cwd, className: "message-image-grid structured-message-images", excludeText: text });
    syncWorkedForDivider(turnId);
  }
  if (item.type === "imageGeneration") {
    const html = renderItemImages(item, { cwd: imageCwd(item), className: "generated-image-grid", thumbnail: true });
    el.innerHTML =
      html ||
      `<div class="generated-image-pending ${item.status === "inProgress" ? "loading-shimmer" : ""}">${item.status === "failed" ? "Image generation failed" : "Generating image"}</div>`;
  }
  if (item.type === "fileChange") {
    for (const ch of item.changes || []) {
      const path = ch.path || ch.filePath || "Changed file";
      state.changes.set(path, ch);
    }
    syncTurnReviewFromItems(turnId);
    renderChanges();
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") updateSideTasks(item);
  if (live) scrollBottom();
}
function activityGroupExpansionKey(activity) {
  const threadId = state.active?.id,
    turnId = activity.closest("[data-turn-id]")?.dataset.turnId,
    anchor = activity.dataset.activityGroupAnchor;
  return threadId && turnId && anchor ? `panda-force-activity-group:${threadId}:${turnId}:${anchor}` : null;
}
function savedActivityGroupExpansion(activity) {
  const key = activityGroupExpansionKey(activity),
    saved = key && storage.get(key);
  return saved === "open" ? true : saved === "closed" ? false : null;
}
function setActivityGroupOpen(activity, open, persist = false) {
  const button = activity.querySelector(".activity-summary"),
    items = activity.querySelector(".activity-items");
  button.classList.toggle("open", open);
  items.classList.toggle("open", open);
  if (persist && !activity.classList.contains("single")) {
    const key = activityGroupExpansionKey(activity);
    if (key) storage.set(key, open ? "open" : "closed");
  }
}
function ensureActivity(turnId, root, itemId, standalone = false) {
  const turn = ensureTurnTimeline(turnId, root),
    stream = turn.querySelector(".turn-event-stream"),
    existing = itemId
      ? turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest("[data-agent-activity-group]")
      : null;
  if (existing) return existing;
  let activity = standalone ? null : state.activities.get(turnId);
  if (
    !activity?.isConnected ||
    activity.parentElement !== stream ||
    stream.lastElementChild !== activity ||
    activity.dataset.standalone === "true"
  ) {
    activity = document.createElement("div");
    activity.className = "activity-group active";
    activity.dataset.agentActivityGroup = "";
    activity.dataset.activityGroupAnchor = String(itemId || "activity");
    if (standalone) activity.dataset.standalone = "true";
    activity.innerHTML = `<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer">Working</span>${icons.chevron}</button><div class="activity-items open"></div>`;
    activity.querySelector(".activity-summary").onclick = () =>
      setActivityGroupOpen(activity, !activity.querySelector(".activity-summary").classList.contains("open"), true);
    stream.append(activity);
    state.activities.set(turnId, activity);
  }
  if (!state.activityItems.has(turnId)) state.activityItems.set(turnId, new Map());
  return activity;
}
function joinActivityText(value) {
  return activityText(value);
}
function activityOutput(item) {
  if (item.type === "reasoning") return joinActivityText(item.summary) || joinActivityText(item.content);
  const output = item.aggregatedOutput ?? item.output?.aggregatedOutput ?? item.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.join("\n");
  return joinActivityText(item.content) || (item.result ? JSON.stringify(item.result, null, 2) : "");
}
function commandText(item) {
  return (
    item.command ||
    (item.commandActions || [])
      .map((action) => action?.command)
      .filter(Boolean)
      .join("\n") ||
    ""
  );
}
function commandExitCode(item) {
  return item.exitCode ?? item.output?.exitCode;
}
function commandFooter(item, data) {
  if (data.active) return { label: "", icon: "" };
  if (item.executionStatus === "interrupted" || item.status === "interrupted" || item.status === "cancelled")
    return { label: "Stopped", icon: "" };
  const exitCode = commandExitCode(item);
  if (data.tone === "error") return { label: exitCode == null ? "Failed" : `Exit code ${exitCode}`, icon: "" };
  return { label: "Success", icon: icons.check };
}
function renderCommandShell(out, item, data) {
  if (out.dataset.outputKind !== "command") {
    out.dataset.outputKind = "command";
    out.className = "activity-output command-shell-wrap";
    out.innerHTML =
      '<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>';
  }
  const output = activityOutput(item),
    pre = out.querySelector(".command-shell-output pre"),
    footer = commandFooter(item, data);
  out.querySelector(".command-shell-command code").textContent = commandText(item);
  pre.textContent = output || (data.active ? "" : "No output");
  pre.classList.toggle("empty", !output);
  out.querySelector(".command-shell-footer").innerHTML = `${footer.icon}<span>${footer.label}</span>`;
}
function inlineFileChangeDiff(change) {
  const raw = unifiedDiffFromFileChanges([change]),
    review = parseUnifiedDiff(raw);
  if (!review.hasChanges) {
    const diff = change.diff || change.unified_diff || "";
    return diff ? `<pre>${escapeHtml(diff)}</pre>` : "";
  }
  return `<div class="file-change-inline-diff">${review.files.flatMap((file) => file.hunks.map((hunk) => `<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join("")}</div></div>`)).join("")}</div>`;
}
function renderFileChangeOutput(out, item, data) {
  out.dataset.outputKind = "file-change";
  out.className = "activity-output file-change-output";
  const changes = item.changes || [],
    legacy = activityOutput(item);
  if (!changes.length) {
    out.innerHTML = `<div class="file-change-progress ${data.active ? "loading-shimmer" : ""}">${escapeHtml(legacy || (data.active ? "Waiting for patch details…" : "No patch details"))}</div>`;
    return;
  }
  out.innerHTML = changes
    .map((change) => {
      const path = change.path || change.filePath || "Changed file",
        kind = typeof change.kind === "string" ? change.kind : change.kind?.type || "update";
      return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon("fileDiff")}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`;
    })
    .join("");
}
function isExplorationActivity(item, data = summarizeActivity(item)) {
  return item.type === "commandExecution" && ["read", "search", "list"].includes(data.category);
}
function renderActivityOutput(out, item, data) {
  if (item.type === "imageView") {
    out.dataset.outputKind = "image";
    out.className = "activity-output activity-image-output";
    out.innerHTML =
      renderItemImages(item, { cwd: imageCwd(item), className: "activity-image-grid", thumbnail: true }) ||
      '<div class="message-image-unavailable" data-i18n-ui>Image unavailable</div>';
    return;
  }
  if (item.type === "commandExecution" && data.category === "command") {
    renderCommandShell(out, item, data);
    return;
  }
  if (item.type === "fileChange") {
    renderFileChangeOutput(out, item, data);
    return;
  }
  if (item.type === "reasoning") {
    const text = activityOutput(item);
    out.dataset.outputKind = "reasoning";
    out.className = "activity-output reasoning-output message-text";
    out.innerHTML = text ? renderAssistantMarkdown(text, { cwd: imageCwd(item) }) : "";
    return;
  }
  out.dataset.outputKind = "plain";
  out.className = "activity-output";
  out.textContent = isExplorationActivity(item, data) ? "" : activityOutput(item) || "";
}
function activityItemExpansionKey(row) {
  const threadId = state.active?.id,
    turnId = row.closest("[data-turn-id]")?.dataset.turnId,
    itemId = row.dataset.itemId;
  return threadId && turnId && itemId ? `panda-force-activity-item:${threadId}:${turnId}:${itemId}` : null;
}
function savedActivityItemExpansion(row) {
  const key = activityItemExpansionKey(row),
    saved = key && storage.get(key);
  return saved === "open" ? true : saved === "closed" ? false : null;
}
function setActivityExpanded(row, expanded, persist = false) {
  row.classList.toggle("expanded", expanded);
  row.setAttribute("aria-expanded", String(expanded));
  if (persist) {
    const key = activityItemExpansionKey(row);
    if (key) storage.set(key, expanded ? "open" : "closed");
  }
}
function motionIcon(name) {
  return `<span class="activity-motion" data-animation="${name}"></span>`;
}
function mountMotion(row) {
  // Use an inspectable CSS animation rather than redistributed desktop assets.
  const holder = row.querySelector(".activity-motion");
  if (holder) holder.innerHTML = codexIcon("loaderCircle", "motion-fallback");
}

function activityIconName(item, data = summarizeActivity(item)) {
  if (item.type === "reasoning") return null;
  if (data.tone === "error") return "triangleAlert";
  if (item.type === "fileChange") return "fileDiff";
  if (data.category === "image") return "image";
  if (data.category === "read") return "file";
  if (data.category === "search" || item.type === "webSearch") return "search";
  if (data.category === "list") return "list";
  if (data.category === "command") return "terminal";
  return "wrench";
}
function stopMotion(row, tone) {
  const holder = row.querySelector(".activity-motion"),
    turnId = row.closest("[data-turn-id]")?.dataset.turnId,
    item = state.activityItems.get(turnId)?.get(row.dataset.itemId),
    data = item ? summarizeActivity(item) : { tone };
  if (!holder) return;
  const icon = activityIconName(item || {}, data);
  holder.innerHTML = icon ? codexIcon(icon) : "";
}
function activityItemId(item) {
  return String(item.id || item.callId || item.requestId || `${item.type}-${Date.now()}`);
}
function joinActivityParts(parts) {
  return parts.length < 2 ? parts[0] || "Worked" : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
function completedActivitySummary(items) {
  const summaries = items.map((item) => ({ item, data: summarizeActivity(item) })),
    commands = summaries.filter(
      ({ item, data }) => item.type === "commandExecution" && data.category === "command",
    ).length,
    explored = summaries.some(
      ({ data }) => ["read", "search", "list"].includes(data.category) && data.tone !== "error",
    ),
    edits = summaries
      .filter(({ item, data }) => item.type === "fileChange" && data.tone !== "error")
      .reduce((count, { item }) => count + Math.max(1, item.changes?.length || 0), 0),
    web = summaries.some(({ item, data }) => item.type === "webSearch" && data.tone !== "error"),
    images = summaries.some(({ data }) => data.category === "image" && data.tone !== "error"),
    failed = summaries.some(({ data }) => data.tone === "error"),
    parts = [],
    add = (leading, following) => parts.push(parts.length ? following : leading);
  if (edits) add(edits === 1 ? "Edited a file" : "Edited files", edits === 1 ? "edited a file" : "edited files");
  if (explored) add("Read files", "read files");
  if (commands)
    add(commands === 1 ? "Ran a command" : "Ran commands", commands === 1 ? "ran a command" : "ran commands");
  if (web) add("Searched the web", "searched the web");
  if (images) add("Viewed images", "viewed images");
  if (!parts.length && failed) return "Activity failed";
  return joinActivityParts(parts);
}
function completedActivityPrimaryItem(items) {
  const summaries = items.map((item) => ({ item, data: summarizeActivity(item) })),
    find = (predicate) => summaries.find(predicate)?.item;
  return (
    find(({ item, data }) => item.type === "fileChange" && data.tone !== "error") ||
    find(({ data }) => ["read", "search", "list"].includes(data.category) && data.tone !== "error") ||
    find(({ data }) => data.category === "command" && data.tone !== "error") ||
    find(({ item, data }) => item.type === "webSearch" && data.tone !== "error") ||
    find(({ data }) => data.category === "image" && data.tone !== "error") ||
    items.find((item) => summarizeActivity(item).tone === "error") ||
    items[0]
  );
}
function setActivitySummaryIcon(activity, item) {
  const holder = activity.querySelector(".activity-summary-icon"),
    icon = item && activityIconName(item);
  if (holder) {
    holder.hidden = !icon;
    holder.innerHTML = icon ? codexIcon(icon) : "";
  }
}
function commandRowSummary(item, data, expanded) {
  if (data.active) return data.label;
  const interrupted =
      item.executionStatus === "interrupted" || item.status === "interrupted" || item.status === "cancelled",
    command = commandText(item);
  if (expanded) return interrupted ? "Stopped command" : "Ran command";
  return `${interrupted ? "Stopped" : "Ran"}${command ? ` ${command}` : " command"}`;
}
function updateCommandRowSummary(row, item, data, expanded = row.classList.contains("expanded")) {
  const summary = row.querySelector(".activity-name");
  if (summary) summary.textContent = commandRowSummary(item, data, expanded);
}
function updateActivitySummary(activity) {
  if (renderingTurn) {
    pendingActivitySummaries.add(activity);
    return;
  }
  const turn = activity.closest("[data-turn-id]"),
    turnId = turn?.dataset.turnId,
    allItems = state.activityItems.get(turnId),
    rows = [...activity.querySelectorAll(".activity-item")].filter((row) => !row.hidden),
    items = rows.map((row) => allItems?.get(row.dataset.itemId)).filter(Boolean),
    summary = activity.querySelector(".activity-summary-copy");
  if (!turn || !summary) return;
  activity.hidden = items.length === 0;
  activity.classList.toggle("single", items.length === 1);
  const activeItem =
      items.findLast?.((item) => summarizeActivity(item).active) ||
      [...items].reverse().find((item) => summarizeActivity(item).active),
    savedOpen = savedActivityGroupExpansion(activity);
  if (activeItem) {
    const data = summarizeActivity(activeItem);
    setActivitySummaryIcon(activity, activeItem);
    summary.textContent = data.label;
    summary.classList.add("loading-shimmer");
    activity.classList.add("active");
    setActivityGroupOpen(activity, items.length === 1 || (savedOpen ?? true));
  } else {
    setActivitySummaryIcon(activity, completedActivityPrimaryItem(items));
    summary.textContent = completedActivitySummary(items);
    summary.classList.remove("loading-shimmer");
    activity.classList.remove("active");
    setActivityGroupOpen(activity, items.length === 1 || (savedOpen ?? false));
  }
  syncWorkedForDivider(turnId);
}
function addActivity(item, activity, id = activityItemId(item)) {
  const turn = activity.closest("[data-turn-id]"),
    turnId = turn.dataset.turnId,
    items = state.activityItems.get(turnId) || new Map(),
    box = activity.querySelector(".activity-items");
  item = mergeReasoningItem(items.get(id), item);
  const data = summarizeActivity(item);
  items.set(id, item);
  state.activityItems.set(turnId, items);
  let row = box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "activity-item entering";
    row.dataset.itemId = id;
    box.append(row);
    const out = document.createElement("div");
    out.className = "activity-output";
    box.append(out);
  }
  const imageView = item.type === "imageView",
    reasoning = item.type === "reasoning",
    command = item.type === "commandExecution" && data.category === "command",
    fileChange = item.type === "fileChange",
    wasActive = row.dataset.activityWasActive === "true",
    savedExpanded = savedActivityItemExpansion(row),
    existingExpanded = row.dataset.expansionInitialized ? row.classList.contains("expanded") : imageView,
    expanded = reasoning
      ? data.active
        ? true
        : wasActive
          ? false
          : (savedExpanded ?? existingExpanded)
      : (savedExpanded ?? existingExpanded);
  row.dataset.expansionInitialized = "true";
  row.dataset.activityWasActive = String(data.active);
  row.className = `activity-item ${command ? "command-activity " : ""}${reasoning ? "reasoning-activity " : ""}${imageView ? "image-activity " : ""}${fileChange ? "file-change-activity " : ""}${data.active ? "active" : "settled"} ${data.tone}`;
  if (command) {
    row.innerHTML = `<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}">${escapeHtml(commandRowSummary(item, data, expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`;
  } else if (reasoning) {
    row.innerHTML = `<div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}">${escapeHtml(data.label)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`;
  } else {
    const detail = shortPath(data.detail || "");
    row.innerHTML = `${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active ? "loading-shimmer" : ""}"><span class="activity-label">${escapeHtml(data.label)}</span>${detail ? ` <span class="activity-detail">${escapeHtml(detail)}</span>` : ""}</div></div><span class="activity-result">${fileChange ? icons.chevron : ""}</span>`;
  }
  const out = row.nextElementSibling;
  row.hidden = reasoning && !data.active && !activityOutput(item).trim();
  out.hidden = row.hidden;
  renderActivityOutput(out, item, data);
  const reasoningOutput = reasoning && !!activityOutput(item),
    expandable =
      imageView ||
      command ||
      fileChange ||
      (reasoning && !data.active && reasoningOutput) ||
      (!reasoning && !isExplorationActivity(item, data) && !!activityOutput(item));
  if (reasoning && data.active && reasoningOutput) {
    row.removeAttribute("role");
    row.removeAttribute("aria-expanded");
    row.tabIndex = -1;
    row.classList.add("expanded");
  } else if (expandable) {
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    setActivityExpanded(row, expanded);
  } else {
    row.removeAttribute("role");
    row.removeAttribute("aria-expanded");
    row.tabIndex = -1;
    row.classList.remove("expanded");
  }
  row.onclick = expandable
    ? () => {
        const next = !row.classList.contains("expanded");
        setActivityExpanded(row, next, true);
        if (command) updateCommandRowSummary(row, item, data, next);
      }
    : null;
  row.onkeydown = expandable
    ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          row.click();
        }
      }
    : null;
  if (!command && !reasoning) {
    if (data.active) mountMotion(row, data.animation);
    else stopMotion(row, data.tone);
  }
  updateActivitySummary(activity);
}
function diffForTurn(turnId) {
  return state.turnDiffs.get(turnId) || null;
}
function recordTurnReview(turnId, raw, source = "fileChange") {
  if (!turnId || !raw) return null;
  const existing = state.turnDiffs.get(turnId);
  if (source !== "native" && existing?.source === "native") return existing;
  const review = parseUnifiedDiff(raw);
  if (!review.hasChanges) return null;
  review.turnId = turnId;
  review.raw = raw;
  review.source = source;
  state.turnDiffs.set(turnId, review);
  state.activeReview = review;
  $("#reviewTab").hidden = false;
  renderChanges();
  return review;
}
function syncTurnReviewFromItems(turnId) {
  if (renderingTurn) {
    pendingTurnReview = true;
    return;
  }
  const items = state.activityItems.get(turnId),
    changes = items
      ? [...items.values()].flatMap((item) =>
          item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : [],
        )
      : [],
    raw = unifiedDiffFromFileChanges(changes);
  if (raw) recordTurnReview(turnId, raw);
}
function saveReviewPreferences() {
  storage.set(STORAGE_KEYS.reviewPreferences, JSON.stringify(reviewPreferences));
}
function reviewLineHtml(line) {
  if (!line) return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';
  return `<div class="review-line ${line.type}"><span class="review-sign">${line.type === "add" ? "+" : line.type === "delete" ? "−" : " "}</span><code>${escapeHtml(line.text)}</code></div>`;
}
function reviewHunkHtml(hunk) {
  if (reviewPreferences.mode === "split") {
    return `<div class="review-split-lines">${splitDiffHunk(hunk)
      .map(
        (row) =>
          `<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`,
      )
      .join("")}</div>`;
  }
  return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join("")}</div>`;
}
function syncReviewControls(review) {
  const has = !!review?.hasChanges;
  $("#reviewMode").disabled = !has;
  $("#reviewWrap").disabled = !has;
  $("#reviewExpand").disabled = !has;
  $("#reviewPatch").disabled = !has || !state.active?.id || !review?.turnId;
  $("#reviewMode").title = reviewPreferences.mode === "unified" ? "Switch to split diff" : "Switch to unified diff";
  $("#reviewWrap").title = reviewPreferences.wrap ? "Disable word wrap" : "Enable word wrap";
  $("#reviewExpand").title = reviewPreferences.expanded ? "Collapse all diffs" : "Expand all diffs";
  $("#reviewPatch").title = reviewPatchState === "undo" ? "Undo changes" : "Reapply changes";
  $("#reviewPatch").innerHTML = codexIcon(reviewPatchState === "undo" ? "undo" : "redo");
}
function renderChanges() {
  if (renderingTurn) {
    pendingChangesRender = true;
    return;
  }
  const list = $("#changeList"),
    review = state.activeReview || [...state.turnDiffs.values()].at(-1) || null,
    reviewVisible = document.body.classList.contains("side-panel-open") && !$("#reviewPanelContent").hidden;
  document.body.classList.toggle(
    "review-split-open",
    reviewVisible && reviewPreferences.mode === "split" && !!review?.hasChanges && innerWidth > 1200,
  );
  list.dataset.mode = reviewPreferences.mode;
  list.classList.toggle("wrap", reviewPreferences.wrap);
  if (review?.hasChanges) {
    $("#changeCount").textContent = review.fileCount;
    $("#changeSummary").textContent = `${review.fileCount} changed file${review.fileCount === 1 ? "" : "s"}`;
    $("#reviewStats").innerHTML =
      `<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`;
    list.innerHTML = "";
    for (const file of review.files) {
      const section = document.createElement("section");
      section.className = "review-file";
      section.dataset.path = file.path;
      section.innerHTML = `<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon("chevronDown", "review-chevron")}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded ? "" : " hidden"}></div>`;
      const body = section.querySelector(".review-hunks");
      for (const hunk of file.hunks) {
        const h = document.createElement("div");
        h.className = "review-hunk";
        h.innerHTML = `<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`;
        body.append(h);
      }
      section.querySelector(".review-file-head").onclick = (e) => {
        const open = e.currentTarget.getAttribute("aria-expanded") === "true";
        e.currentTarget.setAttribute("aria-expanded", String(!open));
        body.hidden = open;
      };
      list.append(section);
    }
    syncReviewControls(review);
    return;
  }
  $("#reviewStats").textContent = "";
  $("#changeCount").textContent = state.changes.size;
  $("#changeSummary").textContent = state.changes.size
    ? `${state.changes.size} changed file${state.changes.size === 1 ? "" : "s"}`
    : "No changes yet";
  list.innerHTML = "";
  for (const [path, ch] of state.changes) {
    const el = document.createElement("div");
    el.className = "change-item";
    el.innerHTML = `<div class="change-path">${icons.file}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions || 0}</span> <span class="minus">−${ch.deletions || 0}</span></div>`;
    list.append(el);
  }
  if (!state.changes.size) list.innerHTML = '<div class="panel-empty">Changes will appear here.</div>';
  syncReviewControls(null);
}
async function applyActiveReviewPatch() {
  const review = state.activeReview;
  if (!review?.turnId || !state.active?.id) return;
  const action = reviewPatchState,
    button = $("#reviewPatch");
  button.disabled = true;
  button.innerHTML = codexIcon("loaderCircle", "review-loading");
  try {
    const response = await fetch("/api/review/patch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: state.active.id, turnId: review.turnId, action }),
      }),
      result = await response.json();
    if (!response.ok) throw new Error(result.error || "Review patch failed");
    if (state.activeReview !== review) return;
    reviewPatchState = action === "undo" ? "reapply" : "undo";
    toast(action === "undo" ? "Changes reverted" : "Changes reapplied");
  } catch (error) {
    addPersistentError(error.message);
  } finally {
    if (state.activeReview === review) syncReviewControls(review);
  }
}
function applyTerminalInteraction(p) {
  const itemId = String(p.itemId),
    current = state.activityItems.get(p.turnId)?.get(itemId);
  if (current?.type !== "commandExecution") return;
  let buffer = current.terminalInputBuffer || "",
    commands = [];
  for (const char of String(p.stdin || "")) {
    if (char === "\r" || char === "\n") {
      const command = buffer.trim();
      if (command) commands.push(command);
      buffer = "";
      continue;
    }
    if (char === "\u0003") {
      buffer = "";
      continue;
    }
    if (char === "\b" || char === "\u007f") {
      buffer = buffer.slice(0, -1);
      continue;
    }
    buffer += char;
  }
  const actions = [...(current.commandActions || []), ...commands.map((command) => ({ type: "unknown", command }))];
  upsertItem({ ...current, status: "inProgress", terminalInputBuffer: buffer, commandActions: actions }, p.turnId);
}

function belongsToActiveThread(p) {
  return Boolean(state.active) && (!p.threadId || p.threadId === state.active.id);
}
function onNotification(method, p) {
  if (method === "thread/queue/changed") {
    refreshMessageQueue(p.threadId);
    return;
  }
  if ((method === "item/started" || method === "item/completed") && p.item?.type === "userMessage") {
    const threadId = p.threadId || state.active?.id;
    settleQueuedMessage(p.item, p.turnId, p.threadId);
    commitSessionModelSettings(threadId);
  }
  // A notification without an explicit thread id is not safe to attribute to
  // the currently selected session. It may be a bridge or account-level
  // failure, so only explicit thread ids get a session error surface.
  const eventThreadId = typeof p.threadId === "string" && p.threadId ? p.threadId : null;
  const activityThreadId = eventThreadId || state.active?.id;
  if (method === "turn/started") {
    recordTurnTiming(
      p.turn?.id,
      p.turn ? { ...p.turn, startedAt: p.turn.startedAt ?? p.pandaReceivedAt } : { startedAt: p.pandaReceivedAt },
    );
    clearThreadError(activityThreadId);
    updateThreadListActivity(activityThreadId, {
      status: { type: "active" },
      turnId: p.turn?.id,
      turnStatus: "inProgress",
      timestamp: Date.now() / 1000,
    });
  } else if (method === "turn/completed") {
    recordTurnTiming(p.turn?.id, p.turn || {});
    updateThreadListActivity(activityThreadId, {
      status: { type: "idle" },
      turnId: p.turn?.id,
      turnStatus: p.turn?.status || "completed",
      completed: true,
      timestamp: Date.now() / 1000,
    });
    if (
      eventThreadId &&
      (p.turn?.status === "failed" || p.turn?.status === "error" || p.turn?.error || p.turn?.failure)
    )
      rememberThreadError(eventThreadId, p.turn?.error || p.turn?.failure || p.turn?.status, p.turn?.id);
    else if (eventThreadId && p.turn?.status === "completed") clearThreadError(eventThreadId);
  } else if (method === "thread/status/changed") {
    if (p.status?.type === "active") clearThreadError(p.threadId);
    updateThreadListActivity(p.threadId, { status: p.status });
  } else if (method === "thread/settings/updated")
    applySessionSettings(p.threadId, p.threadSettings || p.settings || p);
  else if (method.startsWith("item/")) updateThreadListActivity(activityThreadId, { timestamp: Date.now() / 1000 });
  if (method === "thread/status/changed" && errorStatus(p.status))
    rememberThreadError(p.threadId, p.status?.error || p.status?.failure || p.status);
  if (method === "error" && eventThreadId) {
    const failure = p.error || p.message || p;
    rememberThreadError(eventThreadId, failure);
  }
  if (method === "thread/goal/cleared") {
    state.goals.delete(p.threadId);
    if (p.threadId === goalDialogThreadId) closeGoalDialog();
    syncGoalStatusSurface();
    return;
  }
  if (method === "goal/status/changed" || method === "goal/progress" || method === "thread/goal/updated") {
    applyGoalStatusEvent(method, p);
    return;
  }
  if (method === "serverRequest/resolved") {
    resolveServerRequest(p.requestId);
    return;
  }
  if (
    (method.startsWith("item/") || method.startsWith("turn/") || (method === "error" && p.threadId)) &&
    !belongsToActiveThread(p)
  ) {
    if (method === "turn/completed") {
      maybeNotifyTaskCompleted(p);
      refreshThreadsSoon();
    }
    return;
  }
  if (method === "account/updated") {
    resetUsage();
    loadAccount(true);
    if (usagePageVisible()) loadUsage();
  }
  if (method === "account/rateLimits/updated") {
    applyPushedUsageLimits(p);
  } else if (method === "thread/started") {
    clearThreadError(p.thread.id);
    const index = state.threads.findIndex((thread) => thread.id === p.thread.id);
    if (index < 0) state.threads.unshift(p.thread);
    else state.threads[index] = { ...state.threads[index], ...p.thread };
    renderThreads();
  } else if (method === "thread/name/updated") {
    const t = state.threads.find((x) => x.id === p.threadId);
    if (t) t.name = p.name;
    if (state.active?.id === p.threadId) state.active.name = p.name;
    renderThreads();
    renderHeader();
    if (!$("#summaryPanel").hidden) syncSummaryPanel();
  } else if (method === "turn/started") {
    if (!p.threadId || p.threadId === state.active?.id) setActiveTurnId(p.turn?.id || "");
    scheduleActiveThreadSync(0);
  } else if (method === "item/started") upsertItem({ ...p.item, status: "inProgress" }, p.turnId);
  else if (method === "item/completed") {
    const status = ["failed", "declined", "interrupted", "cancelled", "canceled"].includes(p.item?.status)
      ? p.item.status
      : "completed";
    upsertItem(
      { ...p.item, status, ...(p.item?.type === "agentMessage" ? { receivedAt: p.pandaReceivedAt } : {}) },
      p.turnId,
    );
  } else if (method === "item/agentMessage/delta") {
    let el = state.items.get(p.itemId);
    if (!el) {
      upsertItem({ id: p.itemId, type: "agentMessage", text: "", receivedAt: p.pandaReceivedAt }, p.turnId);
      el = state.items.get(p.itemId);
    }
    const body = el.querySelector(".message-text");
    body.dataset.raw = (body.dataset.raw || "") + p.delta;
    body.innerHTML = renderAssistantMarkdown(body.dataset.raw, { cwd: imageCwd() });
    scrollBottom();
  } else if (method === "item/reasoning/summaryPartAdded") upsertReasoningDelta(p, null);
  else if (method === "item/reasoning/summaryTextDelta") upsertReasoningDelta(p, "summary");
  else if (method === "item/reasoning/textDelta") upsertReasoningDelta(p, "content");
  else if (method === "item/commandExecution/outputDelta") {
    const turn = state.turns.get(p.turnId),
      row = turn?.querySelector(`[data-item-id="${CSS.escape(p.itemId)}"]`),
      item = state.activityItems.get(p.turnId)?.get(String(p.itemId));
    if (item) item.aggregatedOutput = (item.aggregatedOutput || "") + (p.delta || "");
    if (row) {
      const target = row.nextElementSibling.querySelector(".command-shell-output pre") || row.nextElementSibling;
      target.textContent = (target.classList.contains("empty") ? "" : target.textContent || "") + (p.delta || "");
      target.classList.remove("empty");
    }
  } else if (method === "item/commandExecution/terminalInteraction") applyTerminalInteraction(p);
  else if (method === "item/fileChange/outputDelta") {
    const itemId = String(p.itemId),
      current = state.activityItems.get(p.turnId)?.get(itemId),
      item =
        current?.type === "fileChange"
          ? { ...current, status: "inProgress" }
          : { id: itemId, type: "fileChange", status: "inProgress", changes: [] };
    item.aggregatedOutput = (item.aggregatedOutput || "") + (p.delta || "");
    upsertItem(item, p.turnId);
  } else if (method === "item/fileChange/patchUpdated") {
    const itemId = String(p.itemId),
      current = state.activityItems.get(p.turnId)?.get(itemId),
      item =
        current?.type === "fileChange"
          ? { ...current, status: "inProgress", changes: p.changes || [] }
          : { id: itemId, type: "fileChange", status: "inProgress", changes: p.changes || [] };
    upsertItem(item, p.turnId);
  } else if (method === "turn/diff/updated") {
    if (p.threadId && state.active?.id && p.threadId !== state.active.id) return;
    recordTurnReview(p.turnId, p.diff || "", "native");
  } else if (method === "turn/completed") {
    const completedTurn = p.turn ? { ...p.turn, completedAt: p.turn.completedAt ?? p.pandaReceivedAt } : p.turn;
    recordTurnTiming(p.turn?.id, completedTurn || {});
    if (!eventThreadId && (p.turn?.status === "failed" || p.turn?.error))
      addPersistentError(p.turn?.error || "Codex turn failed", { key: p.turn?.id ? `turn:${p.turn.id}` : undefined });
    if ((!p.threadId || p.threadId === state.active?.id) && (!p.turn?.id || activeTurnId() === p.turn.id))
      setActiveTurnId("");
    if (p.turn?.items)
      for (const i of p.turn.items)
        upsertItem(i.type === "agentMessage" ? { ...i, receivedAt: p.pandaReceivedAt } : i, p.turn.id);
    if (p.turn?.id) syncWorkedForDivider(p.turn.id, turnDurationMs(p.turn));
    syncSessionStatusSurface();
    maybeNotifyTaskCompleted(p);
    scheduleActiveThreadSync(0);
    refreshThreadsSoon();
  } else if (method === "thread/tokenUsage/updated") {
    const threadId = p.threadId || state.active?.id;
    if (threadId && p.tokenUsage) state.tokenUsage.set(threadId, p.tokenUsage);
    if (threadId === state.active?.id) renderContextUsage();
  } else if (method === "thread/status/changed") {
    if (p.threadId === state.active?.id) {
      state.active.status = p.status;
      scheduleActiveThreadSync(0);
    }
    refreshThreadsSoon();
  } else if (method === "error" && !eventThreadId)
    addPersistentError(p.error || p.message || "Codex error", {
      key: p.turnId ? `turn:${p.turnId}` : p.id ? `codex:${p.id}` : undefined,
    });
}
function upsertReasoningDelta(p, field) {
  const itemId = String(p.itemId),
    items = state.activityItems.get(p.turnId),
    current = items?.get(itemId),
    item =
      current?.type === "reasoning"
        ? { ...current, status: "inProgress" }
        : { id: itemId, type: "reasoning", status: "inProgress", summary: [], content: [] };
  if (field) {
    const index = field === "summary" ? (p.summaryIndex ?? 0) : (p.contentIndex ?? 0),
      parts = Array.isArray(item[field]) ? [...item[field]] : [];
    while (parts.length <= index) parts.push("");
    parts[index] = (parts[index] || "") + (p.delta || "");
    item[field] = parts;
  }
  upsertItem(item, p.turnId);
  scrollBottom();
}
function setApprovalWaiting(group, itemId, waiting) {
  if (!group?.matches("[data-agent-activity-group]")) return;
  const row = itemId ? group.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) : null,
    summary = group.querySelector(".activity-summary-copy");
  group.classList.toggle("waiting-approval", waiting);
  if (waiting) {
    summary.textContent = "Waiting for approval";
    summary.classList.remove("loading-shimmer");
    if (row) {
      row.querySelector(".activity-name")?.classList.remove("loading-shimmer");
    }
  } else {
    if (row) {
      row.querySelector(".activity-name")?.classList.add("loading-shimmer");
    }
    updateActivitySummary(group);
  }
}
const {
  onServerRequest,
  resolveServerRequest,
  restorePendingApprovals,
  clearApprovals,
  hasPendingApproval,
  refreshPendingApprovals,
} = createApprovals({
  i18n,
  onPendingChange: () => workbench?.refresh(),
  $,
  t,
  state,
  approvalMenuController,
  respondToCodex: (requestId, result, error) => respondToCodex(requestId, result, error),
  addPersistentError: (message) => addPersistentError(message),
  escapeHtml: (value) => escapeHtml(value),
  shortPath: (path) => shortPath(path),
  belongsToActiveThread: (params) => belongsToActiveThread(params),
  ensureTurnTimeline: (turnId) => ensureTurnTimeline(turnId),
  ensureActivity: (turnId, root, itemId) => ensureActivity(turnId, root, itemId),
  setApprovalWaiting: (group, itemId, waiting) => setApprovalWaiting(group, itemId, waiting),
  scrollBottom: () => scrollBottom(),
  diffForTurn: (turnId) => diffForTurn(turnId),
  openReviewPanel: (review) => openReviewPanel(review),
});

const slashCommandCatalog = [
  {
    id: "goal",
    title: "Goal",
    description: "Create or manage a persistent Goal",
    icon: "target",
    requiresThread: true,
  },
  { id: "review", title: "Review", description: "Review uncommitted changes", icon: "fileDiff", requiresThread: true },
  {
    id: "fork",
    title: "Fork",
    description: "Create a new task from this history",
    icon: "gitBranch",
    requiresThread: true,
  },
  { id: "model", title: "Model", description: "Choose model and reasoning effort", icon: "wrench" },
  { id: "plan", title: "Plan mode", description: "Turn plan mode on", icon: "list" },
  { id: "project", title: "Project", description: "Choose project for new tasks", icon: "folderOpen" },
  { id: "reasoning", title: "Reasoning", description: "Choose reasoning effort", icon: "wrench" },
  { id: "init", title: "Init", description: "Create an AGENTS.md file with instructions for Codex", icon: "file" },
  { id: "mcp", title: "MCP", description: "Show MCP server status", icon: "wrench" },
  { id: "compact", title: "Compact", description: "Compact this task's context", icon: "list", requiresThread: true },
  { id: "side", title: "Side", description: "Open a side task", icon: "messageSquare", requiresThread: true },
  {
    id: "fast",
    title: "Fast",
    description: "Switch execution speed when supported",
    icon: "loaderCircle",
    requiresThread: true,
  },
  {
    id: "feedback",
    title: "Feedback",
    description: "Send product feedback",
    icon: "messageSquare",
    requiresThread: true,
  },
  {
    id: "status",
    title: "Status",
    description: "Show task id, context usage, and rate limits",
    icon: "info",
    requiresThread: true,
  },
];
function closeComposerAutocomplete() {
  const menu = $("#composerAutocomplete");
  autocompleteState.requestId++;
  menu.hidden = true;
  menu.replaceChildren();
  delete menu.dataset.type;
  autocompleteState.match = null;
  autocompleteState.items = [];
  autocompleteState.selected = 0;
  autocompleteState.message = "";
}
function renderComposerAutocomplete() {
  const menu = $("#composerAutocomplete"),
    items = autocompleteState.items;
  menu.innerHTML = "";
  menu.dataset.type = autocompleteState.match?.type || "";
  menu.setAttribute("aria-label", autocompleteState.match?.type === "slash" ? "Slash command menu" : "Mention menu");
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "autocomplete-empty";
    empty.textContent =
      autocompleteState.message ||
      (autocompleteState.match?.type === "mention" ? "Type to search for files" : "No commands");
    menu.append(empty);
  } else
    for (const [index, item] of items.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "autocomplete-item" + (index === autocompleteState.selected ? " selected" : "");
      button.dataset.autocompleteId = item.id;
      button.role = "option";
      button.setAttribute("aria-selected", String(index === autocompleteState.selected));
      button.innerHTML = `${codexIcon(item.icon || "file")}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;
      button.onpointerdown = (event) => event.preventDefault();
      button.onclick = () => selectComposerAutocomplete(index);
      menu.append(button);
    }
  menu.hidden = false;
}
function currentComposerCwd() {
  if (state.projectless && !state.active) return "";
  const path = state.active?.cwd || $("#projectPath").textContent || state.config.defaultCwd;
  return path.startsWith("~") ? state.config.home + path.slice(1) : path;
}
async function searchMentionSuggestions(match) {
  const query = match.query.trim(),
    requestId = ++autocompleteState.requestId;
  if (!query) {
    autocompleteState.items = [];
    autocompleteState.message =
      state.projectless && !state.active ? "Choose a project to mention files" : "Type to search for files";
    renderComposerAutocomplete();
    return;
  }
  const tasks = state.threads
      .filter((thread) => titleOf(thread).toLowerCase().includes(query.toLowerCase()))
      .slice(0, 5)
      .map((thread) => ({
        id: `task:${thread.id}`,
        source: "task",
        threadId: thread.id,
        title: titleOf(thread),
        description: `Task · ${shortPath(thread.cwd)}`,
        icon: "messageSquare",
      })),
    cwd = currentComposerCwd();
  if (!cwd) {
    autocompleteState.items = [
      {
        id: "choose-project",
        source: "action",
        title: "Choose project",
        description: "Select a project to mention files",
        icon: "folderOpen",
      },
      ...tasks,
    ];
    autocompleteState.selected = 0;
    autocompleteState.message = "";
    renderComposerAutocomplete();
    return;
  }
  autocompleteState.items = [];
  autocompleteState.message = "Searching files…";
  renderComposerAutocomplete();
  try {
    const response = await fetch(
        `/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,
        { cache: "no-store" },
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "File search unavailable");
    if (
      requestId !== autocompleteState.requestId ||
      autocompleteState.match?.type !== "mention" ||
      autocompleteState.match.query !== match.query
    )
      return;
    const files = (data.items || []).map((item) => {
      const parts = item.path.split("/");
      return {
        id: `${item.kind}:${item.path}`,
        source: item.kind,
        path: item.path,
        title: parts.at(-1),
        description: parts.length > 1 ? parts.slice(0, -1).join("/") : item.kind === "folder" ? "Folder" : "File",
        icon: item.kind === "folder" ? "folderOpen" : "file",
      };
    });
    autocompleteState.items = [...files, ...tasks];
    autocompleteState.selected = 0;
    autocompleteState.message = autocompleteState.items.length ? "" : "No files or tasks found";
    renderComposerAutocomplete();
  } catch (error) {
    if (requestId !== autocompleteState.requestId) return;
    autocompleteState.items = tasks;
    autocompleteState.message = tasks.length ? "" : error.message;
    renderComposerAutocomplete();
  }
}
function updateComposerAutocomplete() {
  const input = $("#prompt"),
    match = getComposerAutocomplete(input.value, input.selectionStart ?? input.value.length);
  if (!match) {
    closeComposerAutocomplete();
    return;
  }
  autocompleteState.match = match;
  autocompleteState.selected = 0;
  if (match.type === "slash") {
    autocompleteState.requestId++;
    const query = match.query.trim().toLowerCase();
    autocompleteState.items = slashCommandCatalog.filter(
      (item) =>
        (!item.requiresThread || state.active) && (item.id.includes(query) || item.title.toLowerCase().includes(query)),
    );
    autocompleteState.message = "";
    renderComposerAutocomplete();
    return;
  }
  searchMentionSuggestions(match);
}
function moveComposerAutocomplete(delta) {
  if (!autocompleteState.items.length) return;
  autocompleteState.selected =
    (autocompleteState.selected + delta + autocompleteState.items.length) % autocompleteState.items.length;
  renderComposerAutocomplete();
}
function setPlanMode(active) {
  state.planMode = Boolean(active);
  refreshComposerPlaceholder();
  syncPermissionControl();
}
function applyAutocompleteToken(match, replacement) {
  const input = $("#prompt"),
    result = applyComposerSuggestion(input.value, match, replacement);
  input.value = result.text;
  input.setSelectionRange(result.cursor, result.cursor);
  resizePrompt();
}
function renderContextTray() {
  const tray = $("#composerContextTray");
  tray.innerHTML = "";
  for (const mention of state.composerMentions) {
    const chip = document.createElement("div");
    chip.className = "composer-context-chip";
    chip.dataset.contextId = mention.id;
    chip.innerHTML = `${codexIcon(mention.icon || "file")}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon("x")}</button>`;
    chip.querySelector("button").onclick = () => {
      state.composerMentions = state.composerMentions.filter((item) => item.id !== mention.id);
      renderContextTray();
    };
    tray.append(chip);
  }
  tray.hidden = !state.composerMentions.length;
  persistComposerDraft();
}
function selectComposerAutocomplete(index = autocompleteState.selected) {
  const item = autocompleteState.items[index],
    match = autocompleteState.match;
  if (!item || !match) return;
  const id = item.id;
  if (item.source === "action" && id === "choose-project") {
    closeComposerAutocomplete();
    openFolderPicker();
  } else if (item.source === "file" || item.source === "folder") {
    applyAutocompleteToken(match, `@${item.path}`);
    if (!state.composerMentions.some((mention) => mention.id === item.id)) state.composerMentions.push({ ...item });
    renderContextTray();
    closeComposerAutocomplete();
  } else if (item.source === "task") {
    applyAutocompleteToken(match, `@${item.title}`);
    if (!state.composerMentions.some((mention) => mention.id === item.id)) state.composerMentions.push({ ...item });
    renderContextTray();
    closeComposerAutocomplete();
  } else {
    closeComposerAutocomplete();
    if (id === "init") {
      toast("Init requires the native command bridge.");
    } else if (id === "goal") {
      if (state.active) {
        $("#prompt").value = "/goal ";
        resizePrompt();
      } else toast(t("Start a task first"));
    } else if (["compact", "fork", "review", "side", "fast", "feedback"].includes(id)) {
      void submitNativeSlashCommand(state.active, id);
    } else if (id === "plan") {
      setPlanMode(!state.planMode);
      $("#prompt").value = "";
      resizePrompt();
    } else if (id === "model") {
      $("#prompt").value = "";
      resizePrompt();
      openModelMenu();
    } else if (id === "reasoning") {
      $("#prompt").value = "";
      resizePrompt();
      openModelMenu();
    } else if (id === "project") {
      $("#prompt").value = "";
      resizePrompt();
      openFolderPicker();
    } else if (id === "mcp") {
      $("#prompt").value = "";
      resizePrompt();
      toast("MCP status requires the native desktop status surface.");
    } else if (id === "status") {
      $("#prompt").value = "";
      resizePrompt();
      toast(state.active?.id ? `Task ${state.active.id}` : "No active task");
    }
  }
  requestAnimationFrame(() => $("#prompt").focus());
}
let promptComposing = false;
function composerAttachmentsReady() {
  return state.composerAttachments.every((attachment) => attachment.status === "ready");
}
function renderComposerAttachments() {
  const tray = $("#composerAttachments");
  tray.replaceChildren();
  tray.hidden = !state.composerAttachments.length;
  for (const attachment of state.composerAttachments) {
    const chip = document.createElement("div");
    chip.className = "composer-attachment";
    chip.dataset.status = attachment.status;
    chip.dataset.attachmentId = attachment.id;
    if (attachment.kind === "image" && (attachment.path || attachment.url)) {
      const source = attachment.url ? attachmentDisplayUrl(attachment.url) : localImageUrl(attachment.path);
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "composer-attachment-preview";
      preview.setAttribute("aria-label", attachment.name);
      preview.onclick = () => openImageViewer(source, attachment.name, attachment.url || attachment.path);
      const image = document.createElement("img");
      image.src = source;
      image.alt = attachment.name;
      preview.append(image);
      chip.append(preview);
    } else {
      const icon = document.createElement("span");
      icon.innerHTML = codexIcon("file");
      chip.append(icon);
    }
    const label = document.createElement("span");
    label.className = "composer-attachment-name";
    label.dataset.i18nIgnore = "";
    label.textContent = attachment.name;
    label.title = attachment.error ? t(attachment.error) : attachment.name;
    chip.append(label);
    if (attachment.status !== "ready") {
      const status = document.createElement("span");
      status.className = "composer-attachment-status";
      status.textContent = t(attachment.status === "uploading" ? "Uploading…" : "Upload failed");
      chip.append(status);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-attachment-remove";
    remove.setAttribute("aria-label", t("Remove attachment {name}", { name: attachment.name }));
    remove.innerHTML = codexIcon("x");
    remove.onclick = () => {
      state.composerAttachments = state.composerAttachments.filter((value) => value !== attachment);
      renderComposerAttachments();
      $("#prompt").focus();
    };
    chip.append(remove);
    tray.append(chip);
  }
  syncComposerSubmitState();
  persistComposerDraft();
}
async function uploadComposerFiles(files) {
  for (const file of Array.from(files || [])) {
    if (state.composerAttachments.length >= ATTACHMENT_MAX_COUNT) {
      addPersistentError(t("You can attach up to 10 files"));
      break;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      addPersistentError(t("Each attachment must be 25 MiB or smaller"));
      continue;
    }
    if (!file.size) {
      addPersistentError(t("Cannot upload an empty file"));
      continue;
    }
    const attachment = { id: crypto.randomUUID(), name: file.name, kind: "file", status: "uploading" };
    state.composerAttachments.push(attachment);
    renderComposerAttachments();
    // Keep the same object in saved drafts; a late upload never enters another task.
    void (async () => {
      try {
        const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed");
        Object.assign(attachment, result.attachment);
      } catch (error) {
        attachment.status = "failed";
        attachment.error = error.message;
        if (state.composerAttachments.includes(attachment)) addPersistentError(t(error.message));
      }
      renderComposerAttachments();
    })();
  }
}
$("#composer").addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  $("#composer").classList.add("attachment-dragover");
});
$("#composer").addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || !$("#composer").contains(event.relatedTarget))
    $("#composer").classList.remove("attachment-dragover");
});
$("#composer").addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  $("#composer").classList.remove("attachment-dragover");
  uploadComposerFiles(event.dataTransfer.files);
});
$("#prompt").addEventListener("paste", (event) => {
  const files = filesFromClipboard(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    uploadComposerFiles(files);
  }
});
function handlePromptInput(event) {
  persistComposerDraft();
  resizePrompt();
  if (!promptComposing && !event?.isComposing) updateComposerAutocomplete();
}
function handlePromptKeydown(event) {
  // IME candidate confirmation must not submit or select a composer suggestion.
  // Some browsers report the final composition key with keyCode 229 only.
  if (promptComposing || event.isComposing || event.keyCode === 229) return;
  const open = !$("#composerAutocomplete").hidden;
  if (open) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveComposerAutocomplete(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      selectComposerAutocomplete();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposerAutocomplete();
      return;
    }
  }
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    const input = $("#prompt"),
      entry = composerHistory.navigate(
        event.key === "ArrowUp" ? -1 : 1,
        input.value,
        input.selectionStart,
        input.selectionEnd,
      );
    if (entry) {
      event.preventDefault();
      input.value = entry.text;
      input.setSelectionRange(entry.text.length, entry.text.length);
      state.composerMentions = entry.mentions;
      state.composerAttachments = entry.attachments || [];
      renderComposerAttachments();
      closeComposerAutocomplete();
      renderContextTray();
      resizePrompt();
      return;
    }
  }
  if (event.key === "Tab" && !event.shiftKey && ($("#prompt").value.trim() || state.composerAttachments.length)) {
    event.preventDefault();
    queuePrompt();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
}
async function resumeActiveThread(thread = state.active) {
  if (!thread) return null;
  const generation = threadNavigationGeneration;
  const resumed = await rpc("thread/resume", { threadId: thread.id, excludeTurns: true, pandaPrepareInput: true });
  if (generation === threadNavigationGeneration && state.active?.id === thread.id) {
    state.active = { ...state.active, ...resumed.thread };
    renderHeader();
  }
  return resumed;
}
function renderMessageQueue() {
  const root = $("#messageQueue");
  if (!root) return;
  const messages = [...queuedMessages.values()].filter((message) => message.owner === pendingMessageOwner());
  root.hidden = !messages.length;
  root.replaceChildren();
  for (const message of messages) {
    const row = document.createElement("div");
    row.className = "message-queue-row";
    row.dataset.status = message.status;
    row.dataset.clientId = message.clientId;
    const body = document.createElement("span");
    body.className = "message-queue-text";
    body.dataset.i18nIgnore = "";
    body.textContent =
      [message.text, message.attachments?.map((attachment) => attachment.name).join(", ")]
        .filter(Boolean)
        .join(" · ") || t("Image");
    const status = document.createElement("span");
    status.className = "message-queue-status";
    status.textContent = t(
      {
        sending: "Queueing…",
        queued: "Queued",
        starting: "Starting message…",
        failed: "Queue failed",
        unconfirmed: "Queue unconfirmed",
        cancelling: "Cancelling…",
      }[message.status],
    );
    row.append(body, status);
    if ((message.status === "queued" && message.queueId) || message.status === "failed") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-queue-cancel";
      button.textContent = t(message.status === "failed" ? "Dismissing message" : "Cancel queued message");
      button.onclick = () => cancelQueuedMessage(message);
      row.append(button);
    }
    root.append(row);
  }
}
function settleQueuedMessage(item, turnId, threadId = state.active?.id) {
  if (String(item.id).startsWith("local-")) return;
  if (item.clientId) settledQueueMessages.add(item.clientId);
  const message = item.clientId
    ? queuedMessages.get(item.clientId)
    : [...queuedMessages.values()].find(
        (message) =>
          message.owner === threadId &&
          message.status === "starting" &&
          !message.excludedTurns.has(turnId) &&
          composerInputKey(message.content || [{ type: "text", text: message.text }]) ===
            composerInputKey(item.content),
      );
  if (message?.owner !== threadId) return;
  if (!message) return;
  settledQueueMessages.add(message.clientId);
  queuedMessages.delete(message.clientId);
  releasePromptSubmission(message.submissionToken);
  renderMessageQueue();
}
async function refreshMessageQueue(threadId = state.active?.id) {
  if (!threadId) return;
  const version = (queueReadVersions.get(threadId) || 0) + 1;
  queueReadVersions.set(threadId, version);
  try {
    const data = [];
    let cursor;
    do {
      const result = await rpc("thread/queue/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (queueReadVersions.get(threadId) !== version) return;
      data.push(...(result.data || []));
      cursor = result.nextCursor;
    } while (cursor);
    const present = new Set();
    for (const entry of data) {
      const clientId = entry.clientUserMessageId;
      if (settledQueueMessages.has(clientId)) continue;
      present.add(clientId);
      const existing = queuedMessages.get(clientId);
      if (existing) {
        existing.queueId = entry.id;
        if (existing.status !== "cancelling") existing.status = "queued";
        releasePromptSubmission(existing.submissionToken);
      } else {
        const thread = state.threads.find((thread) => thread.id === threadId);
        queuedMessages.set(clientId, {
          clientId,
          owner: threadId,
          queueId: entry.id,
          text: composerTextFromInput(entry.input),
          content: entry.input,
          attachments: attachmentsFromInput(entry.input),
          status: "queued",
          excludedTurns: new Set((thread?.turns || []).map((turn) => turn.id)),
        });
      }
    }
    for (const message of queuedMessages.values())
      if (message.owner === threadId && message.status === "queued" && !present.has(message.clientId))
        message.status = "starting";
    renderMessageQueue();
  } catch (error) {
    /* Keep acknowledged and pending messages visible while offline. */
  }
}
async function cancelQueuedMessage(message) {
  if (message.status === "failed") {
    queuedMessages.delete(message.clientId);
    renderMessageQueue();
    return;
  }
  if (message.status !== "queued" || !message.queueId) return;
  message.status = "cancelling";
  renderMessageQueue();
  try {
    await rpc("thread/queue/delete", { threadId: message.owner, queuedSubmissionId: message.queueId });
    settledQueueMessages.add(message.clientId);
    queuedMessages.delete(message.clientId);
  } catch (error) {
    if (queuedMessages.has(message.clientId)) message.status = "queued";
    addPersistentError(error.message);
  }
  renderMessageQueue();
  refreshMessageQueue(message.owner);
}
async function queuePrompt() {
  const input = $("#prompt"),
    text = input.value.trim(),
    attachments = [...state.composerAttachments],
    content = buildComposerInput(text, attachments),
    owner = pendingMessageOwner();
  if ((!text && !attachments.length) || !composerAttachmentsReady() || promptComposing || promptSubmissions.has(owner))
    return;
  const generation = threadNavigationGeneration,
    token = Symbol(),
    clientId = `queue-${Date.now()}-${++localUserSequence}`;
  let thread = state.active,
    dispatchStarted = false;
  const current = () => generation === threadNavigationGeneration && state.active?.id === thread?.id;
  const message = {
    clientId,
    owner,
    text,
    content,
    attachments,
    status: "sending",
    submissionToken: token,
    excludedTurns: new Set(
      [...(thread?.turns || []).map((turn) => turn.id), ...state.turns.keys(), activeTurnId()].filter(Boolean),
    ),
  };
  const mentions = state.composerMentions,
    model = state.selectedModel,
    productProjectId = state.newSessionProjectId,
    cwd = thread?.cwd || $("#projectPath").textContent.replace(/^~/, state.config.home),
    policy = permissionThreadPolicy();
  queuedMessages.set(clientId, message);
  promptSubmissions.set(owner, token);
  closeComposerAutocomplete();
  renderMessageQueue();
  composerHistory.record({ text, mentions, attachments });
  input.value = "";
  state.composerMentions = [];
  state.composerAttachments = [];
  renderComposerAttachments();
  renderContextTray();
  resizePrompt();
  try {
    if (!thread) {
      const projectless = state.projectless;
      await prepareBusinessSession(productProjectId);
      const result = await rpc("thread/start", {
        cwd,
        model,
        ...policy,
        sessionStartSource: "startup",
        pandaProjectless: projectless,
      });
      thread = { ...result.thread, projectless };
      if (productProjectId) businessProjects.pendingAssignments.set(thread.id, productProjectId);
      message.owner = thread.id;
      if (!promptSubmissions.has(thread.id)) promptSubmissions.set(thread.id, token);
      if (!state.threads.some((item) => item.id === thread.id)) state.threads.unshift(thread);
      if (generation === threadNavigationGeneration) {
        state.active = thread;
        rememberActiveThread(thread.id);
        renderContextUsage();
        renderHeader();
      }
      renderThreads();
    } else if (thread.canAcceptDirectInput !== true) await resumeActiveThread(thread);
    await businessProjects.finishAssignment(thread);
    if (!current()) throw new Error(t("Queue failed"));
    dispatchStarted = true;
    const result = await rpc("thread/queue/add", {
      threadId: thread.id,
      clientUserMessageId: clientId,
      input: content,
    });
    if (queuedMessages.has(clientId)) {
      message.queueId = result.queuedSubmission.id;
      message.status = "queued";
      commitSessionModelSettings(thread.id);
    }
    refreshMessageQueue(thread.id);
  } catch (error) {
    if (!queuedMessages.has(clientId)) return;
    const uncertain =
      dispatchStarted &&
      (error?.silentTransportSwitch ||
        error instanceof TypeError ||
        error?.name === "AbortError" ||
        /timed out|app-server exited/i.test(error?.message || ""));
    // A queue snapshot can confirm an add even if its acknowledgement was lost.
    if (!message.queueId) message.status = uncertain ? "unconfirmed" : "failed";
    if (current() && !uncertain && !message.queueId && !input.value && !state.composerAttachments.length) {
      input.value = text;
      state.composerMentions = mentions;
      state.composerAttachments = attachments;
      renderComposerAttachments();
      renderContextTray();
      resizePrompt();
    }
    if (current() && !message.queueId && !uncertain) addPersistentError(error?.message || t("Queue failed"));
    if (dispatchStarted) refreshMessageQueue(thread.id);
  } finally {
    releasePromptSubmission(token);
    if (
      message.status === "failed" &&
      !current() &&
      thread?.id &&
      !getComposerDraft(thread.id)?.text &&
      !getComposerDraft(thread.id)?.attachments?.length
    ) {
      setComposerDraft(thread.id, { text, mentions, attachments });
      if (state.active?.id === thread.id && !input.value && !state.composerAttachments.length) {
        restoreComposerDraft();
        renderContextTray();
      }
    }
    renderMessageQueue();
    syncComposerSubmitState();
  }
}
async function submitPrompt(event, questionAnswer = null) {
  event.preventDefault();
  const submissionKey = pendingMessageOwner();
  if (questionAnswer && (!questionAnswer.threadId || questionAnswer.threadId !== state.active?.id))
    throw new Error(t("Conversation changed; reopen the question before submitting."));
  if (promptSubmissions.has(submissionKey)) {
    if (questionAnswer) throw new Error(t("A message is still being sent. Please wait and try again."));
    return;
  }
  closeComposerAutocomplete();
  closePermissionMenu();
  const input = $("#prompt"),
    text = questionAnswer ? questionAnswer.text.trim() : input.value.trim(),
    attachments = questionAnswer ? [] : [...state.composerAttachments],
    content = buildComposerInput(text, attachments),
    hasContent = content.length > 0,
    turnId = activeTurnId();
  let thread = state.active;
  const goalCommand = !questionAnswer && !attachments.length ? parseGoalCommand(text) : null;
  if (goalCommand) {
    try {
      await submitGoalCommand(thread, goalCommand);
      if (thread?.id) composerHistory.record({ text, mentions: state.composerMentions, attachments: [] });
    } catch (error) {
      addPersistentError(error.message);
    }
    return;
  }
  const nativeSlashCommand = !questionAnswer && !attachments.length ? parseNativeSlashCommand(text) : null;
  if (nativeSlashCommand) {
    try {
      await submitNativeSlashCommand(thread, nativeSlashCommand);
      input.value = "";
      resizePrompt();
    } catch (error) {
      addPersistentError(error.message);
    }
    return;
  }
  const localSlashCommand = !questionAnswer && !attachments.length ? parseLocalSlashCommand(text) : null;
  if (localSlashCommand) {
    handleLocalSlashCommand(localSlashCommand);
    input.value = "";
    resizePrompt();
    return;
  }
  const generation = threadNavigationGeneration;
  const isCurrent = () => generation === threadNavigationGeneration && state.active?.id === thread?.id;
  if ((!hasContent && !turnId) || (!questionAnswer && !composerAttachmentsReady())) return;
  const submissionToken = Symbol();
  promptSubmissions.set(submissionKey, submissionToken);
  const mentions = questionAnswer ? [] : state.composerMentions,
    model = state.selectedModel,
    productProjectId = state.newSessionProjectId,
    effort = $("#effortSelect").value;
  const cwd = thread?.cwd || $("#projectPath").textContent.replace(/^~/, state.config.home);
  const threadPolicy = permissionThreadPolicy(),
    turnPolicy = permissionTurnPolicy(cwd);
  let optimisticId = null,
    sent = false,
    dispatchStarted = false,
    deliveryUncertain = false;
  try {
    if (turnId && !hasContent) {
      if (thread) await rpc("turn/interrupt", { threadId: thread.id, turnId });
      return;
    }
    // Render before any network request, including creating or resuming a session.
    optimisticId = `local-${Date.now()}-${++localUserSequence}`;
    const optimistic = {
      id: optimisticId,
      type: "userMessage",
      content,
      owner: submissionKey,
      submissionToken,
      turnId: turnId || "optimistic",
      steer: Boolean(turnId),
      delivery: "sending",
      excludedTurns: [...(thread?.turns || []).map((turn) => turn.id), ...state.turns.keys()].filter(
        (id) => id !== turnId,
      ),
    };
    pendingUserMessages.set(optimisticId, optimistic);
    upsertItem(optimistic, optimistic.turnId);
    composerHistory.record({ text, mentions, attachments });
    if (!questionAnswer) {
      input.value = "";
      state.composerMentions = [];
      state.composerAttachments = [];
      renderComposerAttachments();
      renderContextTray();
      resizePrompt();
    }
    if (turnId) {
      let resumed = false;
      if (thread?.canAcceptDirectInput !== true) {
        await resumeActiveThread(thread);
        resumed = true;
      }
      try {
        try {
          dispatchStarted = true;
          await rpc("turn/steer", {
            threadId: thread.id,
            expectedTurnId: turnId,
            input: content,
            ...(attachments.length ? { clientUserMessageId: optimisticId } : {}),
          });
        } catch (error) {
          if (resumed || bridgeErrorCode(error) !== THREAD_NOT_FOUND) throw error;
          dispatchStarted = false;
          await resumeActiveThread(thread);
          dispatchStarted = true;
          await rpc("turn/steer", {
            threadId: thread.id,
            expectedTurnId: turnId,
            input: content,
            ...(attachments.length ? { clientUserMessageId: optimisticId } : {}),
          });
        }
      } catch (error) {
        if (bridgeErrorCode(error) !== NO_ACTIVE_TURN) throw error;
        // A completed turn can still be shown while its notification is in flight.
        // The steer was rejected, so starting a fresh turn cannot duplicate it.
        if (state.active?.id === thread.id && activeTurnId() === turnId) setActiveTurnId("");
        optimistic.turnId = "optimistic";
        optimistic.steer = false;
        optimistic.excludedTurns.push(turnId);
        const node = state.active?.id === thread.id ? state.items.get(optimisticId) : null;
        if (node) {
          delete node.dataset.steer;
          node.dataset.userTurnId = "optimistic";
          $("#conversation").append(node);
        }
        const result = await rpc("turn/start", {
          threadId: thread.id,
          input: content,
          ...(attachments.length ? { clientUserMessageId: optimisticId } : {}),
          model,
          effort,
          cwd,
          ...turnPolicy,
        });
        if (result?.turn?.id) optimistic.turnId = result.turn.id;
      }
      sent = true;
      setPendingMessageDelivery(optimisticId, "sent");
      if (!questionAnswer) clearComposerDraft(thread.id);
      commitSessionModelSettings(thread.id);
      if (isCurrent()) scheduleActiveThreadSync(0);
      return { sent: true };
    }
    if (!thread) {
      const startingProjectless = state.projectless;
      await prepareBusinessSession(productProjectId);
      const res = await rpc("thread/start", {
        cwd,
        model,
        ...threadPolicy,
        sessionStartSource: "startup",
        pandaProjectless: startingProjectless,
      });
      thread = { ...res.thread, projectless: startingProjectless };
      if (productProjectId) businessProjects.pendingAssignments.set(thread.id, productProjectId);
      optimistic.owner = thread.id;
      if (!promptSubmissions.has(thread.id)) promptSubmissions.set(thread.id, submissionToken);
      if (!state.threads.some((item) => item.id === thread.id)) state.threads.unshift(thread);
      if (generation === threadNavigationGeneration) {
        state.active = thread;
        rememberActiveThread(thread.id);
        renderContextUsage();
        renderHeader();
        restorePendingApprovals();
      }
      renderThreads();
    } else if (thread.canAcceptDirectInput !== true) {
      await resumeActiveThread(thread);
    }
    // Navigation changes the visible session, not the destination of this submission.
    await businessProjects.finishAssignment(thread);
    dispatchStarted = true;
    const result = await rpc("turn/start", {
      threadId: thread.id,
      input: content,
      ...(attachments.length ? { clientUserMessageId: optimisticId } : {}),
      model,
      effort,
      cwd,
      ...turnPolicy,
    });
    if (result?.turn?.id) optimistic.turnId = result.turn.id;
    sent = true;
    setPendingMessageDelivery(optimisticId, "sent");
    if (!questionAnswer) clearComposerDraft(thread.id);
    commitSessionModelSettings(thread.id);
    return { sent: true };
  } catch (error) {
    // An echoed item is stronger evidence than a lost acknowledgement.
    if (optimisticId && !pendingUserMessages.has(optimisticId)) {
      sent = true;
      return { sent: true };
    }
    const uncertain =
      dispatchStarted &&
      (error?.silentTransportSwitch ||
        error instanceof TypeError ||
        error?.name === "AbortError" ||
        /timed out|app-server exited/i.test(error?.message || ""));
    deliveryUncertain = uncertain;
    setPendingMessageDelivery(optimisticId, uncertain ? "unconfirmed" : "failed");
    if (isCurrent()) {
      if (!questionAnswer && !uncertain && !input.value && !state.composerAttachments.length) {
        input.value = text;
        state.composerMentions = mentions;
        state.composerAttachments = attachments;
        renderComposerAttachments();
        renderContextTray();
        resizePrompt();
      }
      if (!error?.silentTransportSwitch)
        addPersistentError(uncertain ? t("Delivery unconfirmed") : threadInputErrorMessage(error));
    }
    if (questionAnswer) {
      if (uncertain) return { deliveryUncertain: true };
      throw error;
    }
  } finally {
    releasePromptSubmission(submissionToken);
    if (optimisticId && !sent && !dispatchStarted) setPendingMessageDelivery(optimisticId, "failed");
    if (
      !questionAnswer &&
      hasContent &&
      !sent &&
      !deliveryUncertain &&
      !isCurrent() &&
      thread?.id &&
      !getComposerDraft(thread.id)?.text &&
      !getComposerDraft(thread.id)?.attachments?.length
    ) {
      setComposerDraft(thread.id, { text, mentions, attachments });
      if (state.active?.id === thread.id && !input.value) {
        restoreComposerDraft();
        renderContextTray();
      }
    }
  }
}
function threadSummarySignature(threads) {
  return JSON.stringify(
    threads.map((thread) => [
      thread.id,
      thread.name,
      thread.preview,
      thread.cwd,
      thread.projectless,
      thread.updatedAt,
      thread.recencyAt,
      thread.status,
      thread.error,
      thread.failure,
      thread.lastError,
      thread.model,
      thread.modelProvider,
      thread.reasoningEffort,
    ]),
  );
}
function applyThreadSummaries(threads) {
  threadListHasFreshData = true;
  sidebarCache.saveThreads(threads, state.config.home);
  for (const thread of threads) applySessionSettings(thread.id, thread);
  rememberSummaryErrors(threads);
  void persistentConversationCache.saveSummaries(threads);
  const nextSignature = threadSummarySignature(threads),
    changed = nextSignature !== threadListSignature;
  threadListSignature = nextSignature;
  const previous = new Map(state.threads.map((thread) => [thread.id, thread]));
  state.threads = threads.map((thread) => ({
    ...thread,
    lastActivityAt: Math.max(threadLastActivityAt(thread), previous.get(thread.id)?.lastActivityAt || 0),
  }));
  const summary = state.active && threads.find((thread) => thread.id === state.active.id);
  if (summary) {
    const turns = state.active.turns;
    state.active = { ...state.active, ...summary, turns };
    if (summary.status?.type === "active") scheduleActiveThreadSync(0);
  }
  if (changed) renderThreads();
  else refreshThreadRowMetadata();
  syncGoalStatusSurface();
  syncSessionStatusSurface();
  syncThreadErrorSurface();
  workspacePreparation.complete("sessions");
}
function scheduleThreadListRefresh(delay = THREAD_LIST_POLL_MS) {
  clearTimeout(threadListTimer);
  threadListTimer = setTimeout(
    refreshThreadList,
    document.visibilityState === "hidden" ? Math.max(delay, 8000) : delay,
  );
}
async function refreshThreadList() {
  if (threadListInFlight) {
    scheduleThreadListRefresh(1000);
    return;
  }
  threadListInFlight = true;
  try {
    const result = await rpc("thread/list", { limit: 50, sortKey: "recency_at", sortDirection: "desc" });
    applyThreadSummaries(result.data || []);
  } catch {
  } finally {
    threadListInFlight = false;
    refreshThreadRowMetadata();
    scheduleThreadListRefresh();
  }
}
function refreshThreadsSoon() {
  scheduleThreadListRefresh(600);
}
function resetActiveThreadSync() {
  activeThreadSyncGeneration++;
  clearTimeout(activeThreadSyncTimer);
  activeThreadSyncTimer = null;
  activeThreadSyncSignature = "";
}
function scheduleActiveThreadSync(delay = ACTIVE_THREAD_SYNC_IDLE_MS) {
  clearTimeout(activeThreadSyncTimer);
  if (!state.active) return;
  activeThreadSyncTimer = setTimeout(
    syncActiveThread,
    document.visibilityState === "hidden" ? Math.max(delay, 6000) : delay,
  );
}
let resumeSessionSyncLastAt = 0;
function resumeSessionSync() {
  if (document.visibilityState === "hidden" || Date.now() - resumeSessionSyncLastAt < 1500) return;
  resumeSessionSyncLastAt = Date.now();
  refreshMessageQueue();
  scheduleThreadListRefresh(0);
  syncSessionStatusSurface();
  if (state.active && !activeThreadSyncInFlight) {
    clearTimeout(activeThreadSyncTimer);
    void syncActiveThread();
  } else scheduleActiveThreadSync(0);
}
async function latestThreadTurn(threadId) {
  try {
    const live = await rpc("host/thread/live", { threadId });
    if (live?.active && live.turn) return live.turn;
  } catch {}
  const thread = await readConversation(threadId, state.active);
  return thread?.turns?.at(-1) || null;
}
function activeTurnId() {
  return $("#sendButton")?.dataset.turnId || "";
}
function syncQueueButton() {
  const queue = $("#queueButton");
  if (queue)
    queue.disabled =
      (!$("#prompt").value.trim() && !state.composerAttachments.length) ||
      !composerAttachmentsReady() ||
      promptComposing ||
      promptSubmissions.has(pendingMessageOwner());
}
function syncComposerSubmitState() {
  syncQueueButton();
  const button = $("#sendButton");
  if (!button) return;
  button.disabled = !composerAttachmentsReady();
  const mode = activeTurnId()
      ? $("#prompt").value.trim() || state.composerAttachments.length
        ? "steer"
        : "stop"
      : "send",
    label = mode === "stop" ? "Stop" : mode === "steer" ? "Steer" : "Send message";
  button.dataset.submitMode = mode;
  button.classList.toggle("stop", mode === "stop");
  button.classList.toggle("steer", mode === "steer");
  button.innerHTML = codexIcon(mode === "stop" ? "square" : "arrowUp");
  button.title = t(label);
  button.setAttribute("aria-label", t(label));
}
function setActiveTurnId(turnId = "") {
  const button = $("#sendButton");
  if (!button) return;
  button.dataset.turnId = turnId || "";
  syncComposerSubmitState();
}
function syncTurnRuntime(turn) {
  const active = turn?.status === "inProgress";
  if (active) setActiveTurnId(turn.id);
  else if (activeTurnId() === turn?.id) setActiveTurnId("");
}
function parseGoalCommand(text) {
  const match = String(text || "")
    .trim()
    .match(/^\/goal(?:\s+(.*))?$/is);
  if (!match) return null;
  const value = (match[1] || "").trim(),
    command = value.toLowerCase();
  return {
    command: ["pause", "resume", "clear"].includes(command) ? command : "set",
    objective: ["pause", "resume", "clear"].includes(command) ? "" : value,
  };
}
function parseNativeSlashCommand(text) {
  const command = String(text || "")
    .trim()
    .toLowerCase();
  return ["/compact", "/fork", "/review", "/side", "/fast", "/feedback"].includes(command) ? command.slice(1) : null;
}
function parseLocalSlashCommand(text) {
  const command = String(text || "")
    .trim()
    .toLowerCase();
  return ["/plan", "/model", "/reasoning", "/project", "/mcp", "/status", "/init"].includes(command)
    ? command.slice(1)
    : null;
}
function handleLocalSlashCommand(command) {
  if (command === "plan") {
    setPlanMode(!state.planMode);
    $("#prompt").value = "";
    resizePrompt();
  } else if (command === "model") {
    openModelMenu();
  } else if (command === "reasoning") {
    openModelMenu();
  } else if (command === "project") {
    openFolderPicker();
  } else if (command === "status") {
    toast(state.active?.id ? `Task ${state.active.id}` : "No active task");
  } else if (command === "init") {
    toast("Init requires the native command bridge.");
  } else if (command === "mcp") {
    toast("MCP status requires the native desktop status surface.");
  }
}
async function submitNativeSlashCommand(thread, command) {
  if (!thread?.id) {
    toast(t("Start a task first"));
    return;
  }
  if (command === "compact") {
    await rpc("thread/compact/start", { threadId: thread.id });
    toast("Compaction started");
    return;
  }
  if (command === "review") {
    await rpc("review/start", { threadId: thread.id, target: { type: "uncommittedChanges" }, delivery: "inline" });
    toast("Review started");
    return;
  }
  if (command === "fork") {
    const result = await rpc("thread/fork", { threadId: thread.id, excludeTurns: true });
    if (result?.thread?.id) {
      if (!state.threads.some((item) => item.id === result.thread.id)) state.threads.unshift(result.thread);
      await openThread(result.thread.id);
    }
    return;
  }
  toast(
    command === "side"
      ? "Side tasks require the native side-task bridge"
      : command === "fast"
        ? "Fast mode requires native model controls"
        : "Feedback requires the native feedback bridge",
  );
}
async function submitGoalCommand(thread, command) {
  if (!thread?.id) {
    toast(t("Start a task first"));
    return;
  }
  let result;
  if (command.command === "clear") result = await rpc("thread/goal/clear", { threadId: thread.id, origin: "user" });
  else if (command.command === "pause" || command.command === "resume")
    result = await rpc("thread/goal/set", {
      threadId: thread.id,
      status: command.command === "pause" ? "paused" : "active",
      origin: "user",
    });
  else if (command.objective)
    result = await rpc("thread/goal/set", {
      threadId: thread.id,
      objective: command.objective,
      status: "active",
      origin: "user",
    });
  else {
    openGoalDialog(thread.id);
    return;
  }
  if (result?.goal) applyGoalStatusEvent("thread/goal/updated", { threadId: thread.id, goal: result.goal });
  if (command.command === "clear") state.goals.delete(thread.id);
  $("#prompt").value = "";
  resizePrompt();
  syncGoalStatusSurface(thread.id);
  toast(t(command.command === "clear" ? "Goal cleared" : "Goal updated"));
}
function syncTurnSnapshot(turn, threadId = state.active?.id) {
  if (!turn || !threadId || threadId !== state.active?.id) return false;
  const root = $("#conversation"),
    turns = state.active.turns || [],
    index = turns.findIndex((existing) => existing.id === turn.id);
  if (index < 0) turns.push(turn);
  else turns[index] = turn;
  state.active.turns = turns;
  recordTurnTiming(turn.id, turn);
  root.querySelectorAll(".conversation-loading").forEach((node) => node.remove());
  renderTurn(turn, root);
  syncTurnRuntime(turn);
  updateThreadListActivity(threadId, {
    status: { type: turn.status === "inProgress" ? "active" : "idle" },
    turnId: turn.id,
    turnStatus: turn.status,
    completed: turn.status !== "inProgress",
    timestamp: Number.isFinite(turn.completedAt)
      ? turn.completedAt
      : Number.isFinite(turn.startedAt)
        ? turn.startedAt
        : undefined,
  });
  scrollBottom();
  return true;
}
async function syncActiveThread() {
  if (activeThreadSyncInFlight || !state.active) {
    scheduleActiveThreadSync();
    return;
  }
  const generation = activeThreadSyncGeneration,
    threadId = state.active.id;
  activeThreadSyncInFlight = true;
  let nextDelay = ACTIVE_THREAD_SYNC_IDLE_MS;
  try {
    if (state.active.history) {
      const previous = state.active,
        thread = await readConversation(threadId, previous, { getCurrent: () => state.active });
      if (generation !== activeThreadSyncGeneration || threadId !== state.active?.id) return;
      state.active = thread;
      cacheConversation(thread);
      syncThreadErrorsFromTurns(threadId, thread.turns || []);
      const latest = thread.turns.at(-1);
      if (latest) {
        nextDelay = latest.status === "inProgress" ? ACTIVE_THREAD_SYNC_ACTIVE_MS : ACTIVE_THREAD_SYNC_IDLE_MS;
        syncThreadErrorSurface(threadId);
        syncTurnRuntime(latest);
      } else setActiveTurnId("");
      if (thread.history.reset || thread.history.removedItems) {
        renderThread(thread);
      } else if (!thread.history.unchanged) {
        for (const turn of thread.turns) {
          const old = previous.turns.find((item) => item.id === turn.id);
          if (JSON.stringify(old) !== JSON.stringify(turn)) syncTurnSnapshot(turn, threadId);
        }
      }
      return;
    }
    const turn = await latestThreadTurn(threadId);
    if (generation !== activeThreadSyncGeneration || threadId !== state.active?.id) return;
    if (turn) {
      const signature = JSON.stringify(turn);
      nextDelay = turn.status === "inProgress" ? ACTIVE_THREAD_SYNC_ACTIVE_MS : ACTIVE_THREAD_SYNC_IDLE_MS;
      if (signature !== activeThreadSyncSignature) {
        activeThreadSyncSignature = signature;
        syncTurnSnapshot(turn, threadId);
      }
    }
  } catch (error) {
    void resyncActiveConversation();
  } finally {
    activeThreadSyncInFlight = false;
    if (generation === activeThreadSyncGeneration && threadId === state.active?.id) {
      syncConversationLoadingSurface(false);
      scheduleActiveThreadSync(nextDelay);
    }
  }
}
function resizePrompt() {
  const e = $("#prompt");
  e.style.height = "auto";
  e.style.height = Math.min(190, e.scrollHeight) + "px";
  syncComposerSubmitState();
}
function conversationNearBottom(root = $("#conversation")) {
  return !root || root.scrollHeight - root.scrollTop - root.clientHeight < 80;
}
function syncConversationScrollSurface() {
  const root = $("#conversation"),
    button = $("#conversationScrollBottom");
  if (!root || !button) return;
  button.hidden = conversationNearBottom(root);
  button.setAttribute("aria-hidden", String(button.hidden));
}
function handleConversationScroll() {
  const root = $("#conversation");
  if (!root) return;
  conversationAutoScroll = conversationNearBottom(root);
  syncConversationScrollSurface();
}
function scrollBottom({ force = false } = {}) {
  requestAnimationFrame(() => {
    const root = $("#conversation");
    if (!root || (!force && !conversationAutoScroll)) return;
    root.scrollTop = root.scrollHeight;
    conversationAutoScroll = true;
    syncConversationScrollSurface();
  });
}
function scrollOpenedThreadToBottom() {
  conversationAutoScroll = true;
  scrollBottom({ force: true });
  requestAnimationFrame(() => scrollBottom({ force: true }));
}
function escapeHtml(v = "") {
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
function persistentErrorText(value) {
  if (value && typeof value === "object") {
    const message = String(value.message || value.error?.message || value.error || "Unexpected error");
    return value.additionalDetails ? `${message}\n${value.additionalDetails}` : message;
  }
  return String(value || "Unexpected error");
}
function renderPersistentErrors() {
  const root = $("#persistentErrors");
  if (!root) return;
  root.replaceChildren();
  root.hidden = !state.persistentErrors.length;
  for (const error of state.persistentErrors) {
    const card = document.createElement("article");
    card.className = "persistent-error";
    card.dataset.errorId = error.id;
    card.setAttribute("role", "alert");
    const icon = document.createElement("span");
    icon.className = "persistent-error-icon";
    icon.innerHTML = codexIcon("triangleAlert");
    icon.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "persistent-error-body";
    const heading = document.createElement("strong");
    heading.textContent = t("Error");
    const message = document.createElement("p");
    message.textContent = error.message;
    body.append(heading, message);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "persistent-error-dismiss";
    dismiss.setAttribute("aria-label", t("Dismiss error"));
    dismiss.title = t("Dismiss error");
    dismiss.innerHTML = codexIcon("x");
    dismiss.onclick = () => {
      state.persistentErrors = state.persistentErrors.filter((item) => item.id !== error.id);
      renderPersistentErrors();
    };
    card.append(icon, body, dismiss);
    root.append(card);
  }
}
function addPersistentError(value, { key } = {}) {
  const message = t(persistentErrorText(value)).trim();
  if (!message || message === "Bridge transport changed") return;
  const identity = key || message;
  const existing = state.persistentErrors.find((error) => error.key === identity);
  if (existing) {
    existing.message = message;
    renderPersistentErrors();
    return;
  }
  state.persistentErrors.push({ id: `error-${Date.now()}-${state.persistentErrors.length}`, key: identity, message });
  renderPersistentErrors();
}
function dismissToast() {
  clearTimeout(toast.t);
  toast.project = null;
  const e = $("#toast");
  e.classList.remove("show", "has-action");
  e.replaceChildren();
}
function toast(text, duration = 2200, action = null) {
  const e = $("#toast");
  e.textContent = text;
  e.classList.toggle("has-action", Boolean(action));
  toast.project = action?.project || null;
  const expire = () => {
    clearTimeout(toast.t);
    toast.t = setTimeout(dismissToast, duration);
  };
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.onclick = async () => {
      button.disabled = true;
      await action.run();
    };
    e.append(button);
  }
  e.onfocusin = () => clearTimeout(toast.t);
  e.onfocusout = expire;
  e.onmouseenter = () => clearTimeout(toast.t);
  e.onmouseleave = expire;
  e.classList.add("show");
  expire();
}
function sessionMarker(id) {
  return id ? `${id.slice(0, 12)}…` : t("No active session");
}
function sessionModelDetails(thread = state.active) {
  const id = thread?.id,
    session = id && state.sessionSettings.get(id),
    modelId = thread?.model || session?.model || "",
    catalog = state.models.find((item) => item.model === modelId),
    label = modelId ? (catalog ? modelDisplay(catalog) : modelId) : t("Model unavailable"),
    effort = thread?.reasoningEffort || session?.effort || "";
  return { label, modelId, effort };
}
function syncSummaryPanel() {
  const workspace = state.projectless ? "No project" : $("#projectName").textContent || "Local workspace",
    id = state.active?.id || "",
    marker = $("#summarySessionMarker"),
    copy = $("#copySummarySessionMarker"),
    name = $("#summarySessionName"),
    save = $("#saveSummarySessionName"),
    model = $("#summarySessionModel"),
    effortEl = $("#summarySessionEffort"),
    details = sessionModelDetails();
  $("#summaryWorkspace").textContent = workspace;
  $("#summaryBranch").textContent = state.projectless
    ? ""
    : state.active?.source === "remote"
      ? "Remote workspace"
      : "Local workspace";
  if ($("#summarySessionTitle")) $("#summarySessionTitle").textContent = t("Session");
  if ($("#summarySessionHelp"))
    $("#summarySessionHelp").textContent = t("Send this marker when reporting a session problem.");
  if (marker) {
    marker.textContent = sessionMarker(id);
    marker.title = id || t("No active session");
    marker.dataset.sessionId = id;
  }
  if (copy) {
    copy.disabled = !id;
    copy.title = t("Copy session marker");
    copy.setAttribute("aria-label", t("Copy session marker"));
  }
  if (model) {
    model.textContent = details.label;
    model.title = details.modelId || t("Model unavailable");
  }
  if (effortEl) effortEl.textContent = details.effort ? reasoningLabel(details.effort) : "";
  if (name) {
    if (document.activeElement !== name) name.value = state.active?.name || "";
    name.disabled = !id;
    name.placeholder = t("Auto-generated from first message");
  }
  if (save) {
    save.disabled = !id;
    save.textContent = t("Save session name");
  }
}
async function copySummarySessionMarker() {
  const id = state.active?.id;
  if (!id) return;
  try {
    await copyMessageText(id);
    toast(t("Session marker copied"));
  } catch {
    addPersistentError(t("Copy failed. Please select and copy the message manually."));
  }
}
async function renameActiveSession() {
  const threadId = state.active?.id,
    input = $("#summarySessionName"),
    button = $("#saveSummarySessionName"),
    name = input?.value.trim();
  if (!threadId || !input) return;
  if (!name) {
    addPersistentError(t("Session name cannot be empty"));
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    const result = await rpc("thread/name/set", { threadId, name });
    if (state.active?.id === threadId) state.active.name = result?.thread?.name || name;
    const thread = state.threads.find((item) => item.id === threadId);
    if (thread) thread.name = result?.thread?.name || name;
    renderThreads();
    renderHeader();
    syncSummaryPanel();
    toast(t("Session renamed"));
  } catch (error) {
    addPersistentError(threadInputErrorMessage(error));
  } finally {
    syncSummaryPanel();
  }
}
function overlayPanelsEnabled() {
  return matchMedia("(max-width:1200px)").matches;
}
function setOverlayBackgroundInert(inert) {
  for (const selector of [".topbar", ".sidebar", ".conversation-shell"]) {
    const node = $(selector);
    if (node) node.inert = inert;
  }
}
function focusPanel(panel, closeButton) {
  if (!overlayPanelsEnabled()) return;
  setOverlayBackgroundInert(true);
  panel.setAttribute("aria-modal", "true");
  requestAnimationFrame(() => closeButton.focus());
}
function restorePanelFocus(panel, target) {
  panel.setAttribute("aria-modal", "false");
  if (!document.body.classList.contains("side-panel-open") && !document.body.classList.contains("summary-panel-open"))
    setOverlayBackgroundInert(false);
  if (overlayPanelsEnabled() && target?.isConnected) requestAnimationFrame(() => target.focus());
}
function syncOverlayPanelMode() {
  const overlay = overlayPanelsEnabled(),
    sideOpen = document.body.classList.contains("side-panel-open"),
    summaryOpen = document.body.classList.contains("summary-panel-open");
  setOverlayBackgroundInert(overlay && (sideOpen || summaryOpen));
  $("#sidePanel").setAttribute("aria-modal", String(overlay && sideOpen));
  $("#summaryPanel").setAttribute("aria-modal", String(overlay && summaryOpen));
  if (overlay) {
    const panel = summaryOpen ? $("#summaryPanel") : sideOpen ? $("#sidePanel") : null,
      close = summaryOpen ? $("#closeSummaryPanel") : sideOpen ? $("#closeSidePanel") : null;
    if (panel && close && !panel.contains(document.activeElement)) requestAnimationFrame(() => close.focus());
  }
  renderChanges();
}
function setSidebarOpen(open) {
  const sidebar = $("#sidebar"),
    mobile = mobileSidebarEnabled();
  document.body.classList.toggle("sidebar-hidden", !mobile && !open);
  sidebar.classList.toggle("mobile-open", mobile && open);
  const visible = mobile
    ? sidebar.classList.contains("mobile-open")
    : !document.body.classList.contains("sidebar-hidden");
  $("#toggleSidebar").setAttribute("aria-expanded", String(visible));
  $("#toggleSidebar").setAttribute("aria-pressed", String(visible));
}
function syncSidebarLayout() {
  const mobile = mobileSidebarEnabled();
  if (mobile === sidebarLayoutMobile) return;
  sidebarLayoutMobile = mobile;
  setSidebarOpen(!mobile);
}
function openBrowserPanel() {
  const tab = $("#utilityTab");
  tab.textContent = "Browser";
  tab.dataset.sidePanelTab = "browser";
  tab.hidden = false;
  setSidePanelOpen(true, false);
  setSidePanelView("browser", "Browser");
  updateBrowserControls();
  if (browserState.index < 0 && !overlayPanelsEnabled()) requestAnimationFrame(() => $("#browserUrl").focus());
}
function setSidePanelView(view, title) {
  const launcher = view === "launcher",
    review = view === "review",
    utility = view === "utility",
    browser = view === "browser",
    terminal = view === "terminal",
    sideTask = view === "side-task";
  $("#sidePanelLauncher").hidden = !launcher;
  $("#reviewPanelContent").hidden = !review;
  $("#browserPanel").hidden = !browser;
  $("#sideTerminalPanel").hidden = !terminal;
  $("#sideTaskPanel").hidden = !sideTask;
  $("#utilityPanelContent").hidden = !utility;
  for (const tab of document.querySelectorAll(".side-panel-tab")) {
    const selected = tab.dataset.sidePanelTab === view;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  $("#newTab").hidden = false;
  if (review) $("#reviewTab").hidden = false;
  if (utility || browser || terminal || sideTask) $("#utilityTab").hidden = false;
  $("#sidePanelTitle").textContent = title || (launcher ? "New tab" : review ? "Review" : $("#utilityTab").textContent);
  if (view !== "utility") filesPanel?.close();
  renderChanges();
  if (terminal)
    requestAnimationFrame(() => {
      initializeTerminal(terminalStates.side);
      fitTerminal(terminalStates.side);
      terminalStates.side.term?.focus();
    });
  if (sideTask) renderSideTasks();
  if (overlayPanelsEnabled() && document.body.classList.contains("side-panel-open"))
    requestAnimationFrame(() => $("#closeSidePanel").focus());
}
function openReviewPanel(review = null) {
  state.activeReview = review || [...state.turnDiffs.values()].at(-1) || state.activeReview;
  setSidePanelOpen(true, false);
  setSidePanelView("review", "Review");
}
function openFilesDialog() {
  if (!filesDialog) return;
  setSidePanelOpen(false, false);
  document.body.classList.add("files-workspace");
  $("#filesPanel").hidden = false;
  filesPanel?.open({
    cwd: state.active?.cwd || state.config.defaultCwd || "",
    project: $("#projectName").textContent || "",
  });
  if (!filesDialog.open) {
    if (matchMedia("(min-width: 900px)").matches) filesDialog.show();
    else filesDialog.showModal();
  }
  $("#toggleFilesPanel").setAttribute("aria-expanded", "true");
  $("#toggleFilesPanel").setAttribute("aria-pressed", "true");
  requestAnimationFrame(() => $("#filesSearch").focus());
}
function closeFilesDialog() {
  if (filesDialog?.open) filesDialog.close();
  else {
    filesPanel?.close();
    $("#filesPanel").hidden = true;
  }
  document.body.classList.remove("files-workspace");
  $("#toggleFilesPanel").setAttribute("aria-expanded", "false");
  $("#toggleFilesPanel").setAttribute("aria-pressed", "false");
}
function openUtilityPanel(kind) {
  if (kind === "files") {
    openFilesDialog();
    return;
  }
  if (kind === "browser") {
    openBrowserPanel();
    return;
  }
  const tab = $("#utilityTab");
  if (kind === "terminal") {
    tab.textContent = "Terminal";
    tab.dataset.sidePanelTab = "terminal";
    setSidePanelOpen(true, false);
    setSidePanelView("terminal", "Terminal");
    return;
  }
  if (kind === "side-task") {
    tab.textContent = "Side tasks";
    tab.dataset.sidePanelTab = "side-task";
    setSidePanelOpen(true, false);
    setSidePanelView("side-task", "Side tasks");
    return;
  }
  const labels = {},
    entry = labels[kind];
  if (!entry) return;
  const [title, icon, description] = entry;
  tab.textContent = title;
  tab.dataset.sidePanelTab = "utility";
  $("#utilityPanelTitle").textContent = title;
  $("#utilityPanelDescription").textContent = description;
  $("#utilityPanelIcon").innerHTML = codexIcon(icon);
  const action = $("#utilityPanelAction");
  action.hidden = false;
  action.textContent = "Choose project folder";
  action.onclick = openFolderPicker;
  setSidePanelOpen(true, false);
  setSidePanelView("utility", title);
}
function toggleFilesPanel() {
  if (filesDialog?.open) {
    closeFilesDialog();
    return;
  }
  openFilesDialog();
}
function setSidePanelOpen(open, reset = true) {
  const panel = $("#sidePanel"),
    trigger = $("#toggleSidePanel"),
    wasOpen = !panel.hidden;
  if (open) {
    setSummaryPanelOpen(false);
    if (!wasOpen) {
      sidePanelReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
      panel.hidden = false;
      document.body.classList.add("side-panel-open");
      trigger.setAttribute("aria-pressed", "true");
      trigger.setAttribute("aria-expanded", "true");
    }
    if (reset) setSidePanelView("launcher", "New tab");
    if (!wasOpen) focusPanel(panel, $("#closeSidePanel"));
  } else {
    panel.hidden = true;
    document.body.classList.remove("side-panel-open", "review-split-open");
    trigger.setAttribute("aria-pressed", "false");
    trigger.setAttribute("aria-expanded", "false");
    restorePanelFocus(panel, sidePanelReturnFocus);
    sidePanelReturnFocus = null;
  }
}
function openUsageSummary() {
  toggleAccountMenu(false);
  if (settingsRoutePage()) history.replaceState({}, "", "/");
  hideSettings();
  setSummaryPanelOpen(true);
  $(".summary-panel-scroll").scrollTop = 0;
}
function setSummaryPanelOpen(open) {
  const panel = $("#summaryPanel"),
    trigger = $("#toggleSummaryPanel");
  if (open) {
    setSidePanelOpen(false, false);
    summaryPanelReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    panel.hidden = false;
    document.body.classList.add("summary-panel-open");
    trigger.setAttribute("aria-pressed", "true");
    trigger.setAttribute("aria-expanded", "true");
    syncSummaryPanel();
    renderUsage();
    loadUsage();
    focusPanel(panel, $("#closeSummaryPanel"));
  } else {
    pauseUsageRefresh();
    panel.hidden = true;
    document.body.classList.remove("summary-panel-open");
    trigger.setAttribute("aria-pressed", "false");
    trigger.setAttribute("aria-expanded", "false");
    restorePanelFocus(panel, summaryPanelReturnFocus);
    summaryPanelReturnFocus = null;
  }
}
function closeImageViewer() {
  const dialog = $("#imageViewer");
  if (dialog.open) dialog.close();
}
function openImageViewer(source, title = "Image", path = "") {
  const dialog = $("#imageViewer"),
    image = $("#imageViewerImage");
  imageViewerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("#imageViewerTitle").textContent = title || "Image";
  $("#imageViewerPath").textContent = path || title || "";
  $("#imageViewerError").hidden = true;
  image.hidden = false;
  image.alt = title || "";
  image.src = source;
  $("#imageViewerOriginal").href = source;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $("#closeImageViewer").focus());
}
function currentTerminalCwd() {
  const path =
    state.active?.cwd ||
    storage.get(STORAGE_KEYS.project) ||
    state.config.defaultCwd ||
    $("#projectPath").textContent ||
    ".";
  return path.startsWith("~") ? state.config.home + path.slice(1) : path;
}
function setSidebarSearchOpen(open) {
  const panel = $("#sidebarSearchPanel"),
    input = $("#threadSearch");
  panel.hidden = !open;
  $("#sidebarSearchButton").setAttribute("aria-expanded", String(open));
  if (open) {
    requestAnimationFrame(() => input.focus());
    return;
  }
  if (input.value) {
    input.value = "";
    renderThreads();
  }
}
function setSidebarHelpOpen(open) {
  $("#sidebarHelpMenu").hidden = !open;
  $("#sidebarHelpButton").setAttribute("aria-expanded", String(open));
}

$("#conversation").addEventListener("scroll", handleConversationScroll, { passive: true });
$("#conversationScrollBottom").onclick = () => {
  conversationAutoScroll = true;
  scrollBottom({ force: true });
};

$("#newTab").onclick = () => setSidePanelView("launcher", "New tab");
$("#reviewTab").onclick = () => openReviewPanel(state.activeReview);
$("#utilityTab").onclick = () => setSidePanelView($("#utilityTab").dataset.sidePanelTab, $("#utilityTab").textContent);
$("#openSidePanelTab").onclick = () => setSidePanelView("launcher", "New tab");
for (const action of document.querySelectorAll("[data-side-panel-action]"))
  action.onclick = () =>
    action.dataset.sidePanelAction === "review" ? openReviewPanel() : openUtilityPanel(action.dataset.sidePanelAction);
$("#browserAddressForm").onsubmit = (event) => {
  event.preventDefault();
  navigateBrowser($("#browserUrl").value);
};
$("#browserBack").onclick = () => moveBrowserHistory(-1);
$("#browserForward").onclick = () => moveBrowserHistory(1);
$("#browserRefresh").onclick = () =>
  browserState.index >= 0 && navigateBrowser(browserState.history[browserState.index], { push: false });
$("#reviewMode").onclick = () => {
  reviewPreferences.mode = reviewPreferences.mode === "unified" ? "split" : "unified";
  saveReviewPreferences();
  renderChanges();
};
$("#reviewWrap").onclick = () => {
  reviewPreferences.wrap = !reviewPreferences.wrap;
  saveReviewPreferences();
  renderChanges();
};
$("#reviewExpand").onclick = () => {
  reviewPreferences.expanded = !reviewPreferences.expanded;
  saveReviewPreferences();
  renderChanges();
};
$("#reviewPatch").onclick = applyActiveReviewPatch;
$("#composer").addEventListener("submit", submitPrompt);
$("#prompt").addEventListener("input", handlePromptInput);
$("#prompt").addEventListener("keydown", handlePromptKeydown);
$("#prompt").addEventListener("compositionstart", () => {
  promptComposing = true;
  syncQueueButton();
});
$("#prompt").addEventListener("compositionend", () => {
  promptComposing = false;
  handlePromptInput();
});
$("#prompt").addEventListener("blur", () => {
  promptComposing = false;
  syncQueueButton();
});
$("#threadSearch").addEventListener("input", renderThreads);
document.querySelector('[data-composer-control="add"]').onclick = () => $("#attachmentInput").click();
$("#attachmentInput").onchange = (event) => {
  uploadComposerFiles(event.target.files);
  event.target.value = "";
};
$("#queueButton").onclick = queuePrompt;
$("#newTask").onclick = startNewTask;
$("#projectButton").onclick = openFolderPicker;
$("#composerProjectButton").onclick = openFolderPicker;
$("#projectlessOption").onclick = useProjectless;
$("#accountButton").onclick = (e) => {
  e.stopPropagation();
  if (state.account?.type === "chatgpt") toggleAccountMenu();
  else openSettings("general");
};
$("#folderGo").onclick = () => loadFolders($("#folderPathInput").value);
$("#folderPathInput").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    loadFolders(e.currentTarget.value);
  }
};
$("#folderUp").onclick = () => folderBrowse.parent && loadFolders(folderBrowse.parent);
$("#folderConfirm").onclick = useSelectedFolder;
$("#toggleSummaryPanel").onclick = () => setSummaryPanelOpen($("#summaryPanel").hidden);
$("#closeImageViewer").onclick = closeImageViewer;
$("#imageViewerImage").onload = () => {
  $("#imageViewerImage").hidden = false;
  $("#imageViewerError").hidden = true;
};
$("#imageViewerImage").onerror = () => {
  $("#imageViewerImage").hidden = true;
  $("#imageViewerError").hidden = false;
};
$("#imageViewer").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeImageViewer();
});
$("#imageViewer").addEventListener("close", () => {
  const image = $("#imageViewerImage");
  image.removeAttribute("src");
  if (imageViewerReturnFocus?.isConnected) imageViewerReturnFocus.focus();
  imageViewerReturnFocus = null;
});
function mobileSidebarEnabled() {
  return document.documentElement.classList.contains("mobile-device") || innerWidth < 720;
}
$("#productModeButton").onclick = () => toast(t("Current engine: Codex"));
$("#sidebarSearchButton").onclick = (event) => {
  event.stopPropagation();
  setSidebarSearchOpen($("#sidebarSearchPanel").hidden);
};
$("#sidebarSearchClose").onclick = () => setSidebarSearchOpen(false);
$("#sidebarHelpButton").onclick = (event) => {
  event.stopPropagation();
  setSidebarHelpOpen($("#sidebarHelpMenu").hidden);
};
$("#sidebarHelpSettings").onclick = () => {
  setSidebarHelpOpen(false);
  openSettings("general-settings");
};
$("#sidebarHelpShortcuts").onclick = () => {
  setSidebarHelpOpen(false);
  openSettings("keyboard-shortcuts");
};
$("#accountSettings").onclick = () => openSettings("general-settings");
$("#accountProfile").onclick = () => openSettings("profile");
$("#accountUsage").onclick = openUsageSummary;
$("#refreshUsage").onclick = () => loadUsage();
$("#accountShortcuts").onclick = () => openSettings("keyboard-shortcuts");
for (const button of document.querySelectorAll("[data-settings-page]"))
  button.onclick = () => setSettingsPage(button.dataset.settingsPage);
$("#accountLogout").onclick = async () => {
  if (!confirm("Log out?")) return;
  try {
    await rpc("account/logout");
    sidebarCache.clear({ disableWrites: true });
    conversationCache.clear();
    persistedConversationVersions.clear();
    await persistentConversationCache.clear();
    toggleAccountMenu(false);
    await loadAccount(true);
  } catch (error) {
    addPersistentError(error.message);
  }
};
addEventListener("panda-force:logged-out", () => {
  initialLoadGate.next();
  sidebarCache.clear({ disableWrites: true });
  conversationCache.clear();
  persistedConversationVersions.clear();
  void persistentConversationCache.clear();
});
addEventListener("panda-force:before-login", () => persistComposerDraft());
$("#settingsDialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSettings();
});
$("#languageSelect").value = i18n.preference;
$("#languageSelect").onchange = (event) => i18n.setPreference(event.currentTarget.value);
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
$("#copySummarySessionMarker").onclick = copySummarySessionMarker;
$("#saveSummarySessionName").onclick = renameActiveSession;
$("#summarySessionName").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    renameActiveSession();
  }
};
document.addEventListener("copy", copyConversationFileReferences);
function refreshLocalizedRuntime() {
  $("#languageSelect").value = i18n.preference;
  if (!state.active) $("#threadTitle").textContent = t("New session");
  if (!folderBrowse.selected) $("#folderSelection").textContent = t("No folder selected");
  if (state.account) renderAccount(state.account);
  else
    for (const id of ["accountName", "accountMenuName", "settingsAccountName"]) $(`#${id}`).textContent = t("Settings");
  syncPermissionControl();
  syncModelLabel();
  refreshComposerPlaceholder();
  renderContextUsage();
  renderChanges();
  syncComposerSubmitState();
  renderUsage();
  renderPersistentErrors();
  syncGoalStatusSurface();
  syncSessionStatusSurface();
  if (!$("#modelMenu").hidden) renderModelMenuMain();
  if ($("#settingsDialog").open) {
    const current =
      document.querySelector("[data-settings-page].active")?.dataset.settingsPage ||
      settingsRoutePage() ||
      "general-settings";
    setSettingsPage(current, { updateRoute: false });
    filterSettingsNavigation($("#settingsSearch").value);
  }
}
i18n.subscribe(refreshLocalizedRuntime);
refreshLocalizedRuntime();
$("#toggleFilesPanel").onclick = toggleFilesPanel;
$("#closeFilesDialog").onclick = closeFilesDialog;
filesDialog?.addEventListener("close", () => {
  filesPanel?.close();
  $("#filesPanel").hidden = true;
  $("#toggleFilesPanel").setAttribute("aria-expanded", "false");
  $("#toggleFilesPanel").setAttribute("aria-pressed", "false");
});
$("#toggleSidePanel").onclick = () => setSidePanelOpen($("#sidePanel").hidden);
$("#toggleSidebar").onclick = () =>
  setSidebarOpen(
    mobileSidebarEnabled()
      ? !$("#sidebar").classList.contains("mobile-open")
      : document.body.classList.contains("sidebar-hidden"),
  );
$("#closeSidePanel").onclick = () => setSidePanelOpen(false);
$("#closeSummaryPanel").onclick = () => setSummaryPanelOpen(false);
document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target : null,
    image = target?.closest("[data-image-src]");
  if (image) {
    e.preventDefault();
    openImageViewer(
      image.dataset.imageSrc,
      image.dataset.imageTitle || image.querySelector("img")?.alt || "Image",
      image.dataset.imagePath || "",
    );
    return;
  }
  const citation = target?.closest("a[data-file-reference]");
  if (!citation) return;
  e.preventDefault();
  const reference = {
    path: citation.dataset.fileReference,
    lineStart: Number(citation.dataset.fileLineStart) || null,
    lineEnd: Number(citation.dataset.fileLineEnd) || null,
  };
  dispatchEvent(new CustomEvent("panda-force:file-reference", { detail: reference }));
  filePreview.open({ ...reference, cwd: citation.dataset.fileCwd || imageCwd() });
});
document.addEventListener("click", (e) => {
  const path = e.composedPath();
  if (
    mobileSidebarEnabled() &&
    $("#sidebar").classList.contains("mobile-open") &&
    !path.includes($("#sidebar")) &&
    !path.includes($("#toggleSidebar"))
  )
    setSidebarOpen(false);
  if (!path.includes($("#modelPicker"))) closeModelMenu();
  if (!path.includes($("#permissionPicker"))) closePermissionMenu();
  if (!path.includes($("#accountMenu")) && !path.includes($("#accountButton"))) toggleAccountMenu(false);
  if (!path.includes($("#sidebarSearchPanel")) && !path.includes($("#sidebarSearchButton")))
    setSidebarSearchOpen(false);
  if (!path.includes($("#sidebarHelpMenu")) && !path.includes($("#sidebarHelpButton"))) setSidebarHelpOpen(false);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    pauseUsageRefresh();
    return;
  }
  if (usagePageVisible()) loadUsage();
  if (state.modelLoadStatus === "error") loadModels();
  resumeSessionSync();
});
addEventListener("pageshow", resumeSessionSync);
addEventListener("focus", resumeSessionSync);
addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.closest(".terminal-host")) return;
  if (e.key === "Escape") {
    if (filePreview.isOpen && !$("#imageViewer").open) {
      e.preventDefault();
      filePreview.close();
      return;
    }
    if ($("#imageViewer").open) {
      e.preventDefault();
      closeImageViewer();
      return;
    }
    if ($("#filesDialog").open) {
      e.preventDefault();
      closeFilesDialog();
      return;
    }
    if ($("#goalDialog").open || $("#folderDialog").open || $("#fullAccessDialog").open) return;
    if (e.defaultPrevented) return;
    if (!$("#sidebarSearchPanel").hidden) {
      e.preventDefault();
      setSidebarSearchOpen(false);
      return;
    }
    if (!$("#sidebarHelpMenu").hidden) {
      e.preventDefault();
      setSidebarHelpOpen(false);
      return;
    }
    if ($("#settingsDialog").open) {
      e.preventDefault();
      closeSettings();
      return;
    }
    closeModelMenu();
    closePermissionMenu();
    toggleAccountMenu(false);
    if (document.body.classList.contains("side-panel-open")) setSidePanelOpen(false);
    else if (document.body.classList.contains("summary-panel-open")) setSummaryPanelOpen(false);
  }
  if (workbench?.keyboard(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    startNewTask();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    $("#toggleSidebar").click();
  }
});
addEventListener("resize", () => {
  syncOverlayPanelMode();
  syncSidebarLayout();
  for (const terminalState of Object.values(terminalStates)) requestAnimationFrame(() => fitTerminal(terminalState));
});
workbench = createWorkbench({
  state,
  t,
  i18n,
  preparation: workspacePreparation,
  openThread,
  newTask: startNewTask,
  chooseFolder: openFolderPicker,
  chooseProject: selectWorkbenchProject,
  setProjectless,
  showSettings: openSettings,
  catalog: businessProjects,
  setProjectHidden,
  toggleProjectPinned,
  isProjectPinned,
  taskStatus: deriveSessionStatus,
  hasPendingApproval,
  closeSidebar: () => {
    if (mobileSidebarEnabled()) setSidebarOpen(false);
  },
  openFiles: () => openFilesDialog(),
});
workspacePreparation.registerRetry("configuration", async () => {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load workspace settings");
  state.config = await response.json();
  workbench.refresh();
});
workspacePreparation.registerRetry("connection", () => {
  connect();
  return state.connected;
});
workspacePreparation.registerRetry("sessions", async () => {
  const result = await rpc("thread/list", { limit: 50, sortKey: "recency_at", sortDirection: "desc" });
  applyThreadSummaries(result.data || []);
  return result;
});
workspacePreparation.registerRetry("projects", () =>
  Promise.all([loadProjectVisibilityRaw(), businessProjects.load()]),
);
workspacePreparation.registerRetry("models", () => loadModelsRaw());
workspacePreparation.registerRetry("permissions", () => loadPermissionProfilesRaw());
globalThis.__pandaForceDebug = {
  workbench,
  persistentConversationCache,
  notify: onNotification,
  request: onServerRequest,
  state,
  browserState,
  renderThreads,
  applyThreadSummaries,
  refreshThreadRowMetadata,
  navigateBrowser,
  renderChanges,
  renderAccount,
  renderHeader,
  refreshComposerPlaceholder,
  setProjectless,
  openImageViewer,
  openThread,
  loadInitial,
  startNewTask,
  setSidebarOpen,
  openSettings,
  closeSettings,
  settingsRoutePage,
  selectedPermission,
  permissionThreadPolicy,
  permissionTurnPolicy,
  setPermissionMode,
  setPermissionProfiles,
  setPermissionVisibility,
  renderPermissionMenu,
  filterAppModels,
  renderModels,
  loadModels,
  syncTurnSnapshot,
  recordTurnReview,
  scrollOpenedThreadToBottom,
};
async function boot() {
  workspacePreparation.start("connection");
  workspacePreparation.start("configuration");
  trackMobileViewport();
  const savedProject = storage.get(STORAGE_KEYS.project);
  syncSidebarLayout();
  syncPermissionControl();
  if (cachedSidebar) renderThreads();
  initialConfigReady = (async () => {
    let configured = false;
    try {
      state.config = await takeStartupRead("config", async () => {
        const response = await fetch("/api/config");
        if (!response.ok) throw new Error("Could not load workspace settings");
        return response.json();
      });
      configureAttachmentUrls(state.config.attachmentUrlPrefix);
      if (cachedSidebar?.home && cachedSidebar.home !== state.config.home && !threadListHasFreshData) {
        state.threads = [];
        sidebarCache.saveThreads([], state.config.home);
      }
      configured = true;
    } catch {
      workspacePreparation.fail("configuration");
    }
    let initialProject = savedProject;
    if (savedProject && savedProject !== "~" && state.config.home) {
      const path = normalizeProjectPath(savedProject, state.config.home),
        roots = state.config.browseRoots || [state.config.home];
      if (
        !path ||
        !roots.some((root) => {
          const normalized = normalizeProjectPath(root);
          return normalized && (path === normalized || path.startsWith(normalized === "/" ? "/" : normalized + "/"));
        })
      ) {
        // A deployment can change mounted roots. Keep cached history, but do not
        // restore a workspace or active conversation from the previous runtime.
        initialProject = null;
        storage.remove(STORAGE_KEYS.project);
        rememberActiveThread(null);
        threadNavigationGeneration++;
      }
    }
    if (state.config.projectless || initialProject === "~") setProjectless(false);
    else setWorkspace(initialProject || state.config.defaultCwd || ".", false);
    // Restore local drafts after validating the project, without waiting for
    // model/session RPCs. Keep any text already entered during startup.
    if (configured && !state.active && !$("#prompt").value) restoreComposerDraft();
    if (state.threads.length) renderThreads();
    refreshComposerPlaceholder();
    const initialSettingsPage = settingsRoutePage();
    if (initialSettingsPage) showSettings(initialSettingsPage, { updateRoute: false });
    if (configured) workspacePreparation.complete("configuration");
  })();
  void loadProjectVisibility().catch(() => {});
  // Expiration is also checked on every cache read. Cleanup can wait until the
  // first sidebar/history paint instead of locking IndexedDB during startup.
  setTimeout(pruneConversationCaches, 3000);
  setInterval(pruneConversationCaches, 60_000);
  void restoreCachedStartup(storage.get(STORAGE_KEYS.activeThread), () => true);
  connect();
  loadModels();
  await initialConfigReady;
}

boot().catch((error) => {
  workspacePreparation.fail("configuration");
  console.error("[panda-force] workspace preparation failed", error);
});
