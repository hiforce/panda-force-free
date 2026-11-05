import { createConfigurationReadiness } from "./configuration-readiness.js";
import { createProjectionUpdates } from "./projection-updates.js";
import { createRenderBatch } from "./render-batch.js";
import { createLatestRequestGate } from "../ui-core.js";
import { createStateDomains } from "./state-domains.js";
import { hydrateCodexIcons } from "../codex-icons.js";
import { pandaInterfaceMark } from "../panda-brand.js";
import { createSessionState } from "./session-state.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { getWorkspacePreparation } from "../workspace-preparation.js";
import { createI18n } from "../i18n.js";

// Creates domain stores, scoped capabilities, localization and initial shell assets.
export function assembleEnvironment({}) {
  const $ = (s) => document.querySelector(s);
  const i18n = globalThis.__pandaForceI18n || createI18n();
  const t = (message, values) => i18n.t(message, values);
  const workspacePreparation = getWorkspacePreparation();
  const initialState = {
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
  const configurationReadiness = createConfigurationReadiness();
  const viewUpdates = createProjectionUpdates();
  const renderBatch = createRenderBatch();
  const selection = createLatestRequestGate();
  const stateDomains = createStateDomains(initialState);
  const state = stateDomains.scope("environment").state;
  const stateFor = (owner) => stateDomains.scope(owner);
  function titleOf(t) {
    return (t.name || t.preview || "Untitled session").replace(/\s+/g, " ").trim().slice(0, 110);
  }
  function shortPath(path = "") {
    const home = state.config.home;
    return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
  }
  const sessions = createSessionState(stateDomains.scope("sessionStore").legacyState);
  function escapeHtml(v = "") {
    return String(v).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }
  // Seed the static shell before route rendering replaces its empty-state DOM.
  hydrateCodexIcons();
  $("#windowCodexMark").innerHTML = pandaInterfaceMark("window-panda-mark");
  $("#emptyCodexMark").innerHTML = pandaInterfaceMark("empty-panda-mark");
  return {
    sessions,
    i18n,
    $,
    t,
    configurationReadiness,
    viewUpdates,
    renderBatch,
    selection,
    stateDomains,
    stateFor,
    escapeHtml,
    shortPath,
    workspacePreparation,
    titleOf,
  };
}
