import { createAccountView } from "../account-view.js";
import { createActivityRenderer } from "../activity-renderer.js";
import { createComposerUploads } from "../composer-uploads.js";
import { localizeText } from "../i18n.js";
import { createReviewController } from "../review-controller.js";
import { createSettingsPanel } from "../settings.js";
import { createUsagePanel } from "../usage-panel.js";
import { findElement, findElements, requireElement } from "./../dom.js";
/** @param {import("./ports.js").FeatureOptions<"renderBatch" | "state" | "mutations" | "$" | "escapeHtml" | "shortPath", "notices" | "panels", "review">} options */
export function assembleReview({ renderBatch, $, escapeHtml, shortPath, noticesPort, panelsPort, state, mutations }) {
  const reviewController = createReviewController({
    $,
    escapeHtml,
    shortPath,
    toast: /** @param {Parameters<typeof noticesPort.toast>} args */ (...args) => noticesPort.toast(...args),
    addPersistentError: /** @param {Parameters<typeof noticesPort.addPersistentError>} args */ (...args) =>
      noticesPort.addPersistentError(...args),
    isRenderingTurn: () => renderBatch.active,
    openLauncher: () => panelsPort.setSidePanelView("launcher"),
    state,
    mutations,
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
/** @param {import("./ports.js").FeatureOptions<"renderBatch" | "state" | "mutations" | "escapeHtml" | "shortPath", "turnFrames" | "identity" | "timing", "activity">} options */
export function assembleActivity({
  turnFramesPort,
  renderBatch,
  escapeHtml,
  shortPath,
  identityPort,
  timingPort,
  state,
  mutations,
}) {
  const activityRenderer = createActivityRenderer({
    escapeHtml,
    shortPath,
    ensureTurnTimeline: /** @param {Parameters<typeof turnFramesPort.ensureTurnTimeline>} args */ (...args) =>
      turnFramesPort.ensureTurnTimeline(...args),
    imageCwd: /** @param {Parameters<typeof identityPort.imageCwd>} args */ (...args) => identityPort.imageCwd(...args),
    syncWorkedForDivider: /** @param {Parameters<typeof timingPort.syncWorkedForDivider>} args */ (...args) =>
      timingPort.syncWorkedForDivider(...args),
    isRenderingTurn: () => renderBatch.active,
    state,
    mutations,
  });
  const { ensureActivity, activityItemId, updateActivitySummary, addActivity } = activityRenderer;
  function setApprovalWaiting(group, itemId, waiting) {
    if (!group?.matches("[data-agent-activity-group]")) return;
    const row = itemId ? findElement(`[data-item-id="${CSS.escape(itemId)}"]`, group) : null,
      summary = requireElement(".activity-summary-copy", group);
    group.classList.toggle("waiting-approval", waiting);
    if (waiting) {
      localizeText(summary, "common.waitingForApproval", undefined);
      summary.classList.remove("loading-shimmer");
      if (row) {
        findElement(".activity-name", row)?.classList.remove("loading-shimmer");
      }
    } else {
      if (row) {
        findElement(".activity-name", row)?.classList.add("loading-shimmer");
      }
      updateActivitySummary(group);
    }
  }
  return { setApprovalWaiting, ensureActivity, activityRenderer, activityItemId, updateActivitySummary, addActivity };
}
/** @param {import("./ports.js").FeatureOptions<"drafts" | "viewUpdates" | "state" | "mutations" | "$" | "t", "images" | "notices", "uploads">} options */
export function assembleUploads({ viewUpdates, $, t, imagesPort, noticesPort, state, mutations, drafts }) {
  const { composerAttachmentsReady, renderComposerAttachments, uploadComposerFiles } = createComposerUploads({
    $,
    t,
    openImageViewer: /** @param {Parameters<typeof imagesPort.openImageViewer>} args */ (...args) =>
      imagesPort.openImageViewer(...args),
    addPersistentError: /** @param {Parameters<typeof noticesPort.addPersistentError>} args */ (...args) =>
      noticesPort.addPersistentError(...args),
    onChange: () => {
      viewUpdates.request("composerSubmit");
      viewUpdates.request("composerDraft");
    },
    onAttachmentUpdated: (id, patch) => drafts.updateAttachment(id, patch),
    state,
    mutations,
  });
  function bind() {
    requireElement('[data-composer-control="add"]').onclick = () => $("#attachmentInput").click();
    $("#attachmentInput").onchange = (event) => {
      uploadComposerFiles($("#attachmentInput").files);
      $("#attachmentInput").value = "";
    };
  }
  return {
    bind,
    renderComposerAttachments,
    composerAttachmentsReady,
  };
}
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "$" | "t" | "i18n", "transport", "usage">} options */
export function assembleUsage({ transportPort, $, t, i18n, state, mutations }) {
  const panel = createUsagePanel({
    $,
    t,
    i18n,
    rpc: (method, params) => transportPort.rpc(method, params),
    state,
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
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "$" | "t" | "shortPath" | "viewUpdates", "models" | "panels", "settings">} options */
export function assembleSettings({ $, t, shortPath, modelsPort, panelsPort, viewUpdates, state, mutations }) {
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
    state,
  });
  function bind() {
    for (const button of findElements("[data-settings-page]"))
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
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "$" | "t" | "state", "settings" | "models" | "panels" | "usage", "account">} options */
export function assembleAccount({ $, t, state, settingsPort, modelsPort, panelsPort, usagePort, mutations }) {
  const { loadAccount, renderAccount, toggleAccountMenu } = createAccountView({
    $,
    t,
    setSettingsPage: (page) => settingsPort.setSettingsPage(page),
    filterSettingsNavigation: (query) => settingsPort.filterSettingsNavigation(query),
    syncPermissionSettings: () => modelsPort.syncPermissionSettings(),
    syncPermissionControl: () => modelsPort.syncPermissionControl(),
    state,
    mutations,
  });
  function bind() {
    $("#accountButton").onclick = (e) => {
      e.stopPropagation();
      if (state.account?.type === "chatgpt") toggleAccountMenu();
      else settingsPort.openSettings("general");
    };
    $("#accountSettings").onclick = () => settingsPort.openSettings("general-settings");
    $("#accountProfile").onclick = () => settingsPort.openSettings("profile");
    $("#accountUsage").onclick = /** @param {Parameters<typeof panelsPort.openUsageSummary>} args */ (...args) =>
      panelsPort.openUsageSummary(...args);
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
