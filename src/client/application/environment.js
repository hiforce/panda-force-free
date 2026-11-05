import { createComposerDrafts } from "../composer-drafts.js";
import { escapeHtml } from "../../shared/html.js";
import { hydrateCodexIcons } from "../codex-icons.js";
import { getBrowserI18n, setMessageHtml } from "../i18n.js";
import { pandaInterfaceMark } from "../panda-brand.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { createLatestRequestGate } from "../ui-core.js";
import { getWorkspacePreparation } from "../workspace-preparation.js";
import { requireElement } from "./../dom.js";
import { createConfigurationReadiness } from "./configuration-readiness.js";
import { createProjectionUpdates } from "./projection-updates.js";
import { createRenderBatch } from "./render-batch.js";
import { createSessionState } from "./session-state.js";
import { createInitialState } from "./initial-state.js";
import { createStateDomains } from "./state-domains.js";
// Creates domain stores, scoped capabilities, localization and initial shell assets.
export function assembleEnvironment() {
  const $ = requireElement;
  const i18n = getBrowserI18n();
  const t = i18n.t;
  const workspacePreparation = getWorkspacePreparation();
  const initialState = createInitialState();
  initialState.newSessionProjectId = new URL(location.href).searchParams.get("project") || null;
  initialState.permissionMode = storage.get(STORAGE_KEYS.permissionMode) || "default";
  initialState.permissionVisibility.fullAccess = storage.get(STORAGE_KEYS.permissionFullAccess) !== "false";
  const configurationReadiness = createConfigurationReadiness();
  const viewUpdates = createProjectionUpdates();
  const renderBatch = createRenderBatch();
  const selection = createLatestRequestGate();
  const stateDomains = createStateDomains(initialState);
  const state = stateDomains.scope("environment").state;
  /** @template {import("../contracts/state-grants.js").StateOwner} O @param {O} owner @returns {import("../contracts/ownership.js").StateScope<O>} */
  const stateFor = (owner) => stateDomains.scope(owner);
  function titleOf(t) {
    return (t.name || t.preview || "Untitled session").replace(/\s+/g, " ").trim().slice(0, 110);
  }
  function shortPath(path = "") {
    const home = state.config.home;
    return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
  }
  const sessions = createSessionState({
    state: stateDomains.scope("sessionStore").state,
    mutations: stateDomains.scope("sessionStore").mutations,
  });
  const composerState = stateDomains.scope("composer").state;
  const drafts = createComposerDrafts({
    getActiveThreadId: () => composerState.active?.id,
    getNewDraftKey: () =>
      "__new__:project:" +
      (composerState.newSessionProjectId || "unassigned") +
      ":" +
      (composerState.projectless
        ? "projectless"
        : composerState.workspaceContext?.cwd || composerState.config.defaultCwd || "default"),
    getLegacyNewDraftKey: () =>
      composerState.newSessionProjectId
        ? null
        : "__new__:" +
          (composerState.projectless
            ? "projectless"
            : composerState.workspaceContext?.cwd || composerState.config.defaultCwd || "default"),
    migrateLegacyGlobalDraft: () => !composerState.newSessionProjectId,
    getDraftSnapshot: () => ({
      text: $("#prompt").value,
      mentions: [...composerState.composerMentions],
      attachments: [...composerState.composerAttachments],
    }),
  });
  // Seed the static shell before route rendering replaces its empty-state DOM.
  hydrateCodexIcons();
  setMessageHtml($("#windowCodexMark"), pandaInterfaceMark("window-panda-mark"));
  setMessageHtml($("#emptyCodexMark"), pandaInterfaceMark("empty-panda-mark"));
  return {
    drafts,
    identityKey: globalThis.__pandaForceIdentityKey,
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
