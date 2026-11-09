import type { DirectorySource } from "../../shared/session-discovery.js";
import type { ClientRpc, TransportHandlers } from "./rpc.js";
import type { DataView } from "../../shared/data-view.js";
import type { SessionActivity, ProductProject } from "../../shared/data-contracts.js";
import type {
  Conversation,
  SessionSummary,
  EngineItem,
  EngineTurn,
  EngineModel,
  PermissionProfile,
  PermissionChoice,
  PermissionPolicy,
  GoalCommand,
  ApprovalRequest,
  RequestId,
  Timestamp,
  ProjectVisibility,
  ProjectAssignment,
} from "../../shared/engine/types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { StateScope, StateStore } from "./ownership.js";
import type { StateOwner } from "./state-grants.js";
import type {
  DomLookup,
  I18nRuntime,
  ConfigurationReadiness,
  RenderBatch,
  RequestGate,
  WorkspacePreparation,
} from "./platform.js";
import type { ReviewModel } from "./state.js";
import type { SessionControlView } from "./session-workspace.js";
import type {
  DraftRepository,
  SessionRepository,
  ProjectionUpdates,
  ComposerHistory,
  ConversationRepository,
  SidebarRepository,
  PersistentConversationRepository,
} from "./repositories.js";
type View<T> = DataView<T>;
export interface SessionRuntime {
  get(
    id?: string,
  ):
    | { turn?: { id: string; status: string; historyTailId?: string }; error?: { message: string; turnId?: string } }
    | undefined;
  latestStatus(thread: View<SessionSummary> | null, history?: View<SessionSummary> | null): string;
  activeTurnId(thread: View<SessionSummary> | null): string;
  acceptsTurn(id: string, turnId?: string): boolean;
  update(id: string, change?: SessionActivity): boolean;
  observeTurn(id: string, turn?: View<EngineTurn>, historyTailId?: string): void;
  rememberError(id: string, error: unknown): void;
  clearError(id: string): void;
  remove(id: string): boolean;
  clear(): void;
}
export interface BusinessProjects extends DirectorySource {
  directoryIndex: import("../../shared/session-discovery.js").DirectoryIndex;
  apply(snapshot: unknown): void;
  load(): Promise<void>;
  sessions(): View<SessionSummary>[];
  projects(): View<ProductProject>[];
  get(id: string): View<ProductProject> | null;
  projectForSession(id: string): View<ProductProject> | null;
  assignment(id: string): View<ProjectAssignment> | null;
  readonly ready: boolean;
  readonly revision: number;
  workspace(projectId: string): Promise<{ path: string; state: "preparing" | "ready" }>;
  save(fields: Partial<ProductProject>): Promise<ProductProject>;
  assign(projectId: string | null, sessionIds: readonly string[], revision?: number): Promise<void>;
  history(options?: {
    search?: string;
    directory?: string;
    cursor?: string;
  }): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }>;
  pendingAssignments: Map<string, string>;
  finishAssignment(thread: View<SessionSummary>): Promise<void>;
}
export interface ReviewController {
  diffForTurn(turnId: string): View<ReviewModel> | null;
  recordTurnReview(turnId: string, raw: string, source?: string): View<ReviewModel> | null;
  syncTurnReviewFromItems(turnId: string): void;
  renderChanges(): void;
  resetReviewState(): void;
  flush(turnId?: string): void;
}
export interface ActivityRenderer {
  ensureActivity(turnId: string, root: HTMLElement, itemId: string, standalone?: boolean): HTMLElement;
  activityItemId(item: View<EngineItem>): string;
  updateActivitySummary(activity: HTMLElement | null): void;
  addActivity(item: View<EngineItem>, activity: HTMLElement, id?: string): void;
  flush(): void;
}

export interface ApplicationProjectionsPort {
  bind: () => void;
}

export interface LocalizationPort {
  refreshLocalizedRuntime: () => void;
  bind: () => void;
}

export interface HistoryPort {
  syncConversationLoadingSurface: (loading: boolean) => void;
  readConversation: (
    id: string,
    previous: View<SessionSummary> | null,
    { limit, getCurrent }?: { limit?: number; getCurrent?: () => View<SessionSummary> | null },
  ) => Promise<View<Conversation>>;
  BACKGROUND_CONVERSATION_HISTORY_LIMIT: number;
  INITIAL_CONVERSATION_HISTORY_LIMIT: number;
  conversationItemCount: (thread: View<SessionSummary> | null) => number;
  prefetchEarlierConversation: (thread: View<SessionSummary> | null, navigationId: number) => Promise<void>;
  loadEarlierConversation: (thread: View<SessionSummary> | null) => Promise<View<SessionSummary> | undefined>;
  resyncActiveConversation: () => Promise<boolean>;
}

export interface QueuePort {
  bind: () => void;
  renderMessageQueue: () => void;
  refreshMessageQueue: (threadId?: string) => Promise<void>;
  queuePrompt: () => Promise<void>;
  settleQueuedMessage: (item: View<EngineItem>, turnId: string, threadId?: string) => void;
}

export interface StatusPort {
  deriveSessionStatus: (
    thread?: View<SessionSummary> | null,
  ) => { state: string; label: string; detail: string; icon: string } | null;
  syncSessionStatusSurface: () => void;
  syncThreadErrorSurface: (threadId?: string) => void;
  sessionRuntime: SessionRuntime;
  updateThreadListActivity: (
    threadId: string,
    { status, turnId, turnStatus, completed, timestamp }?: import("../../shared/data-contracts.js").SessionActivity,
  ) => boolean | undefined;
  syncThreadErrorsFromTurns: (threadId: string, turns?: readonly View<EngineTurn>[]) => void;
  refreshThreadRowMetadata: () => void;
  rememberSummaryErrors: (threads: readonly View<SessionSummary>[]) => View<SessionSummary>[];
  updateThreadRowMeta: (row: HTMLElement, thread: View<SessionSummary> | null, meta?: HTMLElement | null) => void;
  errorStatus: (status: unknown) => boolean;
  rememberThreadError: (threadId: string, value: unknown, turnId?: string) => void;
  clearThreadError: (threadId: string) => void;
}

export interface GoalsPort {
  submitGoalCommand: (
    thread: View<SessionSummary> | null,
    command: GoalCommand,
    options?: { preserveDraft?: boolean },
  ) => Promise<void>;
  loadGoal: (threadId: string) => Promise<void>;
  syncGoalDialogSession: () => void;
  syncGoalStatusSurface: (threadId?: string) => void;
  closeGoalDialog: () => void;
  clearGoal: (threadId: string) => void;
  applyGoalStatusEvent: (method: string, payload?: {}) => void;
  openGoalDialog: (threadId?: string) => void;
}

export interface ApprovalsPort {
  pendingInteraction: (id: string) => "approval" | "question" | null;
  pendingCard: (id: string) => HTMLElement | null;
  hasPendingApproval: (id: string) => boolean;
  restorePendingApprovals: () => void;
  approvalMenuController: {
    dispose(): void;
    toggle: (trigger: HTMLElement, menu: HTMLElement) => void;
    close: (restoreFocus?: boolean) => void;
    closeFor: (container: Element | null) => void;
  };
  refreshPendingApprovals: () => Promise<void>;
  onServerRequest: (req: ApprovalRequest, options?: { container?: HTMLElement | null }) => Promise<void>;
  clearApprovals: ({ removeCards }?: { removeCards?: boolean | undefined }) => void;
  resolveServerRequest: (requestId: RequestId) => void;
}

export interface ModelsPort {
  sessionControlView: () => SessionControlView;
  applyModelSelection: (sessionId: string, model: string, effort: string) => void;
  applyPermissionSelection: (sessionId: string, mode: string) => void;
  loadPermissionProfiles: () => Promise<boolean>;
  renderContextUsage: () => void;
  applySessionSettings: (
    threadId: string,
    settings?: View<SessionSummary> | import("../../shared/engine/types.js").SessionSettings,
  ) => void;
  permissionThreadPolicy: () => PermissionPolicy;
  commitSessionModelSettings: (threadId: string) => void;
  syncPermissionControl: () => void;
  openModelMenu: (view?: string) => void;
  loadModels: (options?: { timeoutMs?: number; attempts?: number; retryDelayMs?: number }) => Promise<boolean>;
  loadModelsRaw: ({
    timeoutMs,
    attempts,
    retryDelayMs,
  }?: {
    timeoutMs?: number | undefined;
    attempts?: number | undefined;
    retryDelayMs?: number | undefined;
  }) => Promise<boolean>;
  loadPermissionProfilesRaw: () => Promise<boolean>;
  modelDisplay: (model: View<EngineModel> | undefined, stripPrefix?: boolean) => string;
  selectedModel: () => View<EngineModel> | undefined;
  reasoningLabel: (value: unknown) => string;
  selectedPermission: () => PermissionChoice;
  syncPermissionSettings: () => void;
  maybeNotifyTaskCompleted: (p: Record<string, unknown>) => void;
  closePermissionMenu: () => void;
  permissionTurnPolicy: (cwd: string) => PermissionPolicy;
  syncModelLabel: () => void;
  renderModelMenuMain: () => void;
  closeModelMenu: () => void;
  setPermissionMode: (mode: string) => void;
  setPermissionProfiles: (profiles?: readonly PermissionProfile[]) => void;
  setPermissionVisibility: (kind: string, enabled: boolean) => void;
  renderPermissionMenu: () => void;
  renderModels: () => void;
}

export interface ComposerPort {
  setPlanMode: (active: boolean) => void;
  setComposing: (value: unknown) => void;
  syncQueueButton: () => void;
  saveComposerDraft: () => void;
  syncComposerSubmitState: () => void;
  persistComposerDraft: () => void;
  composerHistory: ComposerHistory;
  restoreComposerDraft: () => void;
  resizePrompt: () => void;
  syncTurnRuntime: (turn: View<EngineTurn> | undefined) => void;
  promptComposing: boolean;
  activeTurnId: () => string;
  getComposerDraft: (threadId?: string) => import("./repositories.js").ComposerDraft | undefined;
  setComposerDraft: (threadId: string, draft: import("./repositories.js").ComposerDraft) => void;
  loadComposerHistory: () => Promise<void>;
  setActiveTurnId: (turnId?: string) => void;
  clearComposerDraft: (threadId?: string) => void;
}

export interface DetailsPort {
  bind: () => void;
  syncSummaryPanel: () => void;
}

export interface SessionWorkspacePort {
  isOpen: () => boolean;
  setOpen: (open: boolean, settings?: { temporary?: boolean }) => void;
  openSettings: (kind: "model" | "permissions") => void;
  bind: () => void;
  refresh: () => void;
  open: (tab?: string) => void;
  close: () => void;
  openUsage: () => void;
}

export interface TimingPort {
  timestampSeconds: (value: unknown) => number | null;
  syncWorkedForDivider: (turnId: string, durationMs?: number | null) => void;
  recordTurnTiming: (turnId: string, turn?: {}) => void;
  turnDurationMs: (turn?: {}) => number | null;
  setMessageTime: (el: HTMLElement, timestamp: Timestamp, label: string) => void;
}

export interface StartupPort {
  dispose: () => void;
  invalidateInitialLoad: () => void;
  loadInitial: (refreshAccount?: boolean) => Promise<void>;
  boot: () => Promise<void>;
  bind: () => void;
}

export interface ViewportPort {
  bind: () => void;
  scrollBottom: ({ force }?: { force?: boolean | undefined }) => void;
  resetAutoScroll: () => void;
  syncConversationScrollSurface: () => void;
  scrollOpenedThreadToBottom: () => void;
  preserveReadingPosition: (render: () => void) => void;
  renderHistoryWhenIdle: (render: () => void) => Promise<void>;
}

export interface NoticesPort {
  getToastProject: () => string | null;
  addPersistentError: (value: unknown, { key }?: { key?: string }) => void;
  toast: (
    text: string,
    duration?: number,
    action?: { label: string; project?: string; run: () => unknown } | null,
  ) => void;
  dismissToast: () => void;
  renderPersistentErrors: () => void;
}

export interface NavigationPort {
  bind: () => void;
  openThread: (id: string, fallbackSummary?: View<SessionSummary> | null) => Promise<boolean>;
  startNewTask: ({
    saveCurrentDraft,
    projectId,
  }?: {
    saveCurrentDraft?: boolean | undefined;
    projectId?: string | null;
  }) => void;
  threadNavigationGeneration: number;
  invalidateNavigation: () => number;
  rememberActiveThread: (id: string | null) => void;
  startupThreadAllowed: (id?: string | null) => boolean;
  restoreCachedStartup: (id: string | null, current: () => boolean) => Promise<void>;
}

export interface CommandsPort {
  submitGoalCommand: GoalsPort["submitGoalCommand"];
  submitNativeSlashCommand: (thread: View<SessionSummary> | null, command: string) => Promise<void>;
  parseGoalCommand: (text: string) => { command: string; objective: string } | null;
  parseNativeSlashCommand: (text: string) => string | null;
  parseLocalSlashCommand: (text: string) => string | null;
  handleLocalSlashCommand: (command: string) => void;
}

export interface SideTasksPort {
  renderSideTasks: () => void;
  flush: () => void;
  updateSideTasks: (item: View<EngineItem>) => void;
}

export interface TurnFramesPort {
  ensureTurnTimeline: (turnId: string, root?: HTMLElement) => HTMLElement;
}

export interface ConnectionPort {
  handle: (message: unknown) => void;
  setStatus: (kind: string, text?: string) => void;
  onDisrupted: () => void;
}

export interface TimelinePort {
  showEmpty: () => void;
  clearConversationRuntime: () => void;
  renderThread: (thread: View<SessionSummary> | null, loadMore?: number) => Promise<void>;
  renderTurn: (turn: View<EngineTurn>, root?: HTMLElement) => void;
}

export interface TransportPort {
  connect: () => void;
  rpc: ClientRpc;
  postBridge: (path: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
  respondToEngine: (requestId: RequestId, result?: unknown, error?: unknown) => Promise<unknown>;
  clearTransportReconnectTimer: () => void;
  resetReconnectBackoff: () => void;
  attach: (handlers: TransportHandlers) => void;
}

export interface ReviewPort {
  diffForTurn: (turnId: string) => View<ReviewModel> | null;
  renderChanges: () => void;
  resetReviewState: () => void;
  reviewController: ReviewController;
  syncTurnReviewFromItems: (turnId: string) => void;
  recordTurnReview: (turnId: string, raw: string, source?: string) => View<ReviewModel> | null;
}

export interface ActivityPort {
  setApprovalWaiting: (group: HTMLElement, itemId: string, waiting: boolean) => void;
  ensureActivity: (turnId: string, root: HTMLElement, itemId: string, standalone?: boolean) => HTMLElement;
  activityRenderer: ActivityRenderer;
  activityItemId: (item: View<EngineItem>) => string;
  updateActivitySummary: (activity: HTMLElement | null) => void;
  addActivity: (item: View<EngineItem>, activity: HTMLElement, id?: string) => void;
}

export interface UploadsPort {
  bind: () => void;
  renderComposerAttachments: () => void;
  composerAttachmentsReady: () => boolean;
}

export interface UsagePort {
  renderUsage: () => void;
  loadUsage: () => Promise<void>;
  usagePageVisible: () => boolean;
  resetUsage: () => void;
  pauseUsageRefresh: () => void;
  showUsageDisconnected: () => void;
  applyPushedUsageLimits: (payload: unknown) => void;
}

export interface SettingsPort {
  bind: () => void;
  openSettings: (page?: string) => void;
  settingsRoutePage: (pathname?: string) => string;
  hideSettings: () => void;
  showSettings: (page?: string, { updateRoute }?: { updateRoute?: boolean | undefined }) => void;
  setSettingsPage: (page?: string, { updateRoute }?: { updateRoute?: boolean | undefined }) => void;
  filterSettingsNavigation: (query?: string) => void;
  closeSettings: () => void;
}

export interface AccountPort {
  bind: () => void;
  toggleAccountMenu: (force?: boolean) => void;
  loadAccount: (refresh?: boolean) => Promise<void>;
  renderAccount: (account: import("../../shared/engine/types.js").PublicAccount | null) => void;
}

export interface ImagesPort {
  bind: () => void;
  openImageViewer: (source: string, title?: string, path?: string) => void;
  closeImageViewer: () => void;
}

export interface ClipboardPort {
  bind: () => void;
  copyUserMessage: (button: HTMLButtonElement) => Promise<void>;
  copyMessageText: (text: string) => Promise<void>;
}

export interface PanelsPort {
  openUtilityPanel: (kind: string) => void;
  dispose: () => void;
  setSummaryPanelOpen: (open: boolean) => void;
  closeFilesDialog: () => void;
  setSidePanelOpen: (open: boolean, reset?: boolean) => void;
  bind: () => void;
  openReviewPanel: (review?: View<ReviewModel> | null) => void;
  openFilesDialog: () => void;
  setSidePanelView: (view: string, title?: string) => void;
  openUsageSummary: () => void;
  navigateBrowser: (value: unknown, { push }?: { push?: boolean | undefined }) => boolean;
  browserState: {
    history: string[];
    index: number;
    loadTimer: ReturnType<typeof setTimeout> | null;
    loadRequest: number;
  };
  filePreview: { readonly isOpen: boolean; open(reference: unknown): Promise<void>; close(): void };
  syncOverlayPanelMode: () => void;
  terminalStates: {
    side: {
      hostId: string;
      panelId: string;
      term: import("@xterm/xterm").Terminal | null;
      fit: import("@xterm/addon-fit").FitAddon | null;
      ws: WebSocket | null;
      resizeObserver: ResizeObserver | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      loading: Promise<void> | null;
    };
  };
  fitTerminal: (terminalState: PanelsPort["terminalStates"]["side"]) => void;
}

export interface BindingsPort {
  bind: () => void;
}

export interface DiagnosticsPort {
  bind: () => void;
}

export interface NotificationsPort {
  belongsToActiveThread: (p: Record<string, unknown>) => boolean;
  onNotification: (method: string, p: Record<string, unknown>) => void;
}

export interface SuggestionsPort {
  closeComposerAutocomplete: () => void;
  renderContextTray: () => void;
  updateComposerAutocomplete: () => void;
  moveComposerAutocomplete: (delta: number) => void;
  selectComposerAutocomplete: (index?: number) => void;
}

export interface SubmissionPort {
  submitPrompt: (
    event: { preventDefault(): void },
    questionAnswer?: { text: string; threadId: string } | null,
  ) => Promise<
    { sent: boolean; deliveryUncertain?: undefined } | { deliveryUncertain: boolean; sent?: undefined } | undefined
  >;
}

export interface MessagesPort {
  appendAssistantDelta: (params: { itemId: string; turnId: string; delta: string; pandaReceivedAt?: number }) => void;
  releaseItem: (node: HTMLElement) => void;
  upsertItem: (item: View<EngineItem>, turnId: string, root?: HTMLElement, live?: boolean) => void;
}

export interface EnvironmentPort {
  drafts: DraftRepository;
  identityKey: string | undefined;
  sessions: SessionRepository;
  i18n: I18nRuntime;
  $: DomLookup;
  t: Translate;
  configurationReadiness: ConfigurationReadiness;
  viewUpdates: ProjectionUpdates;
  renderBatch: RenderBatch;
  selection: RequestGate;
  stateDomains: StateStore;
  stateFor: <O extends StateOwner>(owner: O) => StateScope<O>;
  escapeHtml: (value?: unknown) => string;
  shortPath: (path?: string) => string;
  workspacePreparation: WorkspacePreparation;
  titleOf: (thread: View<SessionSummary>) => string;
}

export interface DeliveryPort {
  pendingMessages: () => readonly View<EngineItem>[];
  confirmMessage: (message: View<EngineItem>) => void;
  isSending: (owner: string) => boolean;
  lock: (owner: string, token: symbol) => void;
  lockIfFree: (owner: string, token: symbol) => void;
  nextMessageId: (prefix: string) => string;
  track: (message: View<EngineItem>) => void;
  hasMessage: (id: string) => boolean;
  renderPendingUserMessages: () => void;
  pendingMessageOwner: () => string;
  releasePromptSubmission: (token: symbol) => void;
  setPendingMessageDelivery: (id: string, delivery: string) => void;
}

export interface SidebarLayoutPort {
  isSidebarOpen: () => boolean;
  bind: () => void;
  mobileSidebarEnabled: () => boolean;
  setSidebarOpen: (open: boolean, settings?: { temporary?: boolean }) => void;
  syncSidebarLayout: () => void;
  setSidebarSearchOpen: (open: boolean) => void;
  setSidebarHelpOpen: (open: boolean) => void;
}

export interface SynchronizationPort {
  stopSynchronization: () => void;
  resetActiveThreadSync: () => void;
  scheduleActiveThreadSync: (delay: number) => void;
  threadListHasFreshData: boolean;
  ACTIVE_THREAD_SYNC_IDLE_MS: number;
  applyThreadSummaries: (threads: readonly View<SessionSummary>[]) => void;
  scheduleThreadListRefresh: (delay?: number) => void;
  refreshThreadList: () => Promise<void>;
  refreshThreadsSoon: () => void;
  resumeSessionSync: () => void;
  syncTurnSnapshot: (turn: View<EngineTurn> | undefined, threadId?: string) => boolean;
}

export interface WorkspacePort {
  applySelectedProjectWorkspace: () => void;
  bind: () => void;
  openFolderPicker: () => void;
  selectWorkbenchProject: (path: string) => Promise<void>;
  setProjectless: (refreshProfiles?: boolean) => void;
  syncProjectControl: () => void;
  renderHeader: () => void;
  prepareBusinessSession: (
    projectId: string | null,
  ) => Promise<{ path: string; state: "preparing" | "ready" } | undefined>;
  refreshComposerPlaceholder: () => void;
  setWorkspace: (path: string, refreshProfiles?: boolean) => void;
  useProjectless: () => void;
  folderBrowse: { path: string; parent: string | null; selected: string | null };
}

export interface RepositoriesPort {
  conversations: ConversationRepository;
  cachedSidebar: import("./repositories.js").SidebarSnapshot | null;
  pruneConversationCaches: () => undefined;
  cacheConversation: (thread: View<SessionSummary> | null) => void;
  sidebarCache: SidebarRepository;
  evictConversationMemory: (id: string) => void;
  persistentConversationCache: PersistentConversationRepository;
}

export interface InputSessionsPort {
  prepareInputSession: (input: {
    thread: View<SessionSummary> | null;
    cwd: string;
    model: string;
    policy: PermissionPolicy;
    projectId: string | null;
    generation: number;
    pending: { owner: string };
    token: symbol;
    resumeExisting?: boolean;
    onCreated?: (thread: View<Conversation>) => void;
  }) => Promise<View<Conversation>>;
  resumeActiveThread: (thread?: View<SessionSummary> | null) => Promise<{ thread: View<SessionSummary> } | null>;
}

export interface IdentityPort {
  claimOptimisticUser: (item: View<EngineItem>, root: HTMLElement, turnId: string) => HTMLElement | null;
  imageCwd: (item?: {}) => string;
  claimEquivalentUserMessage: (item: View<EngineItem>, root: HTMLElement, turnId: string) => HTMLElement | null;
  claimEquivalentAgentMessage: (item: View<EngineItem>, turnId: string) => HTMLElement | null;
  placeAgentMessage: (el: HTMLElement, item: View<EngineItem>, timeline: HTMLElement) => void;
}

export interface ProjectsPort {
  businessProjects: BusinessProjects;
}

export interface SidebarPort {
  dispose: () => void;
  bind: () => void;
  setProjectHidden: (project: string, hidden: boolean, expectedHiddenAt?: number | null) => Promise<ProjectVisibility>;
  toggleProjectPinned: (path: string) => void;
  isProjectPinned: (path: string) => boolean;
  renderThreads: () => void;
  loadProjectVisibility: () => Promise<unknown>;
  loadProjectVisibilityRaw: () => Promise<unknown>;
  applyProjectVisibility: (snapshot: View<ProjectVisibility>) => void;
}

export interface WorkbenchPort {
  workbench: {
    refresh: () => void;
    navigate: (path: string, { replace }?: { replace?: boolean | undefined }) => void;
    threadOpened: (id: string) => void;
    taskStarted: () => void;
    rememberProject: () => void;
    associateSession: (id: string) => Promise<void>;
    openSearch: () => void;
    keyboard: (event: KeyboardEvent) => boolean;
    readonly route: { page: string; id: string; projectId: string };
  };
}

export interface ComposerInteractionsPort {
  bind: () => void;
}
