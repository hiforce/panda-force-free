import { createReviewController } from "../review-controller.js";
import { createActivityRenderer } from "../activity-renderer.js";
import { createComposerUploads } from "../composer-uploads.js";
import { createUsagePanel } from "../usage-panel.js";
import { createSettingsPanel } from "../settings.js";
import { createAccountView } from "../account-view.js";

export function assembleReview({ renderBatch, legacyState, $, escapeHtml, shortPath, noticesPort, panelsPort }) {
  const reviewController = createReviewController({
    $,
    state: legacyState,
    escapeHtml,
    shortPath,
    toast: (...args) => noticesPort.toast(...args),
    addPersistentError: (...args) => noticesPort.addPersistentError(...args),
    isRenderingTurn: () => renderBatch.active,
    openLauncher: () => panelsPort.setSidePanelView("launcher", "New tab"),
  });
  const { diffForTurn, recordTurnReview, syncTurnReviewFromItems, renderChanges, resetReviewState } = reviewController;
  return {
    diffForTurn,
    renderChanges,
    resetReviewState,
    reviewController,
    syncTurnReviewFromItems,
    recordTurnReview,
  };
}

export function assembleActivity({
  turnFramesPort,
  renderBatch,
  legacyState,
  escapeHtml,
  shortPath,
  identityPort,
  timingPort,
}) {
  const activityRenderer = createActivityRenderer({
    state: legacyState,
    escapeHtml,
    shortPath,
    ensureTurnTimeline: (...args) => turnFramesPort.ensureTurnTimeline(...args),
    imageCwd: (...args) => identityPort.imageCwd(...args),
    syncWorkedForDivider: (...args) => timingPort.syncWorkedForDivider(...args),
    isRenderingTurn: () => renderBatch.active,
  });
  const { ensureActivity, activityItemId, updateActivitySummary, addActivity } = activityRenderer;
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
  return { setApprovalWaiting, ensureActivity, activityRenderer, activityItemId, updateActivitySummary, addActivity };
}

export function assembleUploads({ viewUpdates, legacyState, $, t, imagesPort, noticesPort }) {
  const { composerAttachmentsReady, renderComposerAttachments, uploadComposerFiles } = createComposerUploads({
    $,
    t,
    state: legacyState,
    openImageViewer: (...args) => imagesPort.openImageViewer(...args),
    addPersistentError: (...args) => noticesPort.addPersistentError(...args),
    onChange: () => {
      viewUpdates.request("composerSubmit");
      viewUpdates.request("composerDraft");
    },
  });
  function bind() {
    document.querySelector('[data-composer-control="add"]').onclick = () => $("#attachmentInput").click();
    $("#attachmentInput").onchange = (event) => {
      uploadComposerFiles(event.target.files);
      event.target.value = "";
    };
  }
  return {
    bind,
    renderComposerAttachments,
    composerAttachmentsReady,
  };
}

export function assembleUsage({ transportPort, legacyState, $, t, i18n }) {
  const panel = createUsagePanel({
    $,
    t,
    i18n,
    state: legacyState,
    rpc: (method, params) => transportPort.rpc(method, params),
  });
  return {
    renderUsage: panel.renderUsage,
    loadUsage: panel.loadUsage,
    usagePageVisible: panel.usagePageVisible,
    resetUsage: panel.resetUsage,
    pauseUsageRefresh: panel.pauseRefresh,
    showUsageDisconnected: panel.showDisconnected,
    applyPushedUsageLimits: panel.applyPushedLimits,
  };
}

export function assembleSettings({ legacyState, $, t, shortPath, modelsPort, panelsPort, viewUpdates }) {
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
    state: legacyState,
    shortPath: (path) => shortPath(path),
    agentRows: () => [
      ["Model", modelsPort.modelDisplay(modelsPort.selectedModel())],
      ["Reasoning effort", modelsPort.reasoningLabel($("#effortSelect").value)],
      ["Approval", modelsPort.selectedPermission().label],
      ["Web search", "Automatic"],
    ],
    permissionLabel: () => modelsPort.selectedPermission().label,
    openUsageSummary: () => panelsPort.openUsageSummary(),
    toggleAccountMenu: (force) => viewUpdates.request("accountMenu", force),
    syncPermissionSettings: () => modelsPort.syncPermissionSettings(),
  });
  function bind() {
    for (const button of document.querySelectorAll("[data-settings-page]"))
      button.onclick = () => setSettingsPage(button.dataset.settingsPage);
    $("#settingsDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSettings();
    });
  }
  return {
    bind,
    openSettings,
    settingsRoutePage,
    hideSettings,
    showSettings,
    setSettingsPage,
    filterSettingsNavigation,
    closeSettings,
  };
}

export function assembleAccount({ legacyState, $, t, state, settingsPort, modelsPort, panelsPort, usagePort }) {
  const { loadAccount, renderAccount, toggleAccountMenu } = createAccountView({
    $,
    t,
    state: legacyState,
    setSettingsPage: (page) => settingsPort.setSettingsPage(page),
    filterSettingsNavigation: (query) => settingsPort.filterSettingsNavigation(query),
    syncPermissionSettings: () => modelsPort.syncPermissionSettings(),
    syncPermissionControl: () => modelsPort.syncPermissionControl(),
  });
  function bind() {
    $("#accountButton").onclick = (e) => {
      e.stopPropagation();
      if (state.account?.type === "chatgpt") toggleAccountMenu();
      else settingsPort.openSettings("general");
    };
    $("#accountSettings").onclick = () => settingsPort.openSettings("general-settings");
    $("#accountProfile").onclick = () => settingsPort.openSettings("profile");
    $("#accountUsage").onclick = (...args) => panelsPort.openUsageSummary(...args);
    $("#refreshUsage").onclick = () => usagePort.loadUsage();
    $("#accountShortcuts").onclick = () => settingsPort.openSettings("keyboard-shortcuts");
  }
  return {
    bind,
    toggleAccountMenu,
    loadAccount,
    renderAccount,
  };
}
