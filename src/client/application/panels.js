import { storage, STORAGE_KEYS } from "../storage.js";
import { createTerminalPanel } from "../terminal-panel.js";
import { createBrowserController } from "../browser-panel-controller.js";
import { createFilePreview } from "../lazy-file-preview.js";
import { createFilesPanel } from "../files-panel.js";
import { codexIcon } from "../codex-icons.js";

// Owns utility panels, browser and terminal views, overlay focus and keyboard dismissal.
export function assemblePanels({
  viewUpdates,
  mutations,
  t,
  shortPath,
  $,
  state,
  noticesPort,
  workspacePort,
  settingsPort,
  usagePort,
}) {
  const filePreview = createFilePreview({
    t,
    onBackToFiles: () => openFilesDialog(),
    getAttachmentUrlPrefix: () => state.config.attachmentUrlPrefix,
    onError: () => {
      globalThis.__pandaForceCheckAuth?.();
      noticesPort.addPersistentError(t("Could not load file preview. Please retry."));
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
      workspacePort.openFolderPicker();
    },
    shortPath,
  });
  let sidePanelReturnFocus = null,
    summaryPanelReturnFocus = null;
  const { terminalStates, fitTerminal, initializeTerminal } = createTerminalPanel({
    $,
    t,
    getCwd: () => currentTerminalCwd(),
    onAuthCheck: () => globalThis.__pandaForceCheckAuth?.(),
  });
  const { browserState, navigateBrowser, moveBrowserHistory, updateBrowserControls } = createBrowserController({
    $,
  });
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
    viewUpdates.request("review");
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
    $("#sidePanelTitle").textContent =
      title || (launcher ? "New tab" : review ? "Review" : $("#utilityTab").textContent);
    if (view !== "utility") filesPanel?.close();
    viewUpdates.request("review");
    if (terminal)
      requestAnimationFrame(() => {
        initializeTerminal(terminalStates.side);
        fitTerminal(terminalStates.side);
        terminalStates.side.term?.focus();
      });
    if (sideTask) viewUpdates.request("sideTasks");
    if (overlayPanelsEnabled() && document.body.classList.contains("side-panel-open"))
      requestAnimationFrame(() => $("#closeSidePanel").focus());
  }
  function openReviewPanel(review = null) {
    mutations.set("activeReview", review || [...state.turnDiffs.values()].at(-1) || state.activeReview);
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
    action.onclick = (...args) => workspacePort.openFolderPicker(...args);
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
    viewUpdates.request("accountMenu", false);
    if (settingsPort.settingsRoutePage()) history.replaceState({}, "", "/");
    settingsPort.hideSettings();
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
      viewUpdates.request("details");
      usagePort.renderUsage();
      usagePort.loadUsage();
      focusPanel(panel, $("#closeSummaryPanel"));
    } else {
      usagePort.pauseUsageRefresh();
      panel.hidden = true;
      document.body.classList.remove("summary-panel-open");
      trigger.setAttribute("aria-pressed", "false");
      trigger.setAttribute("aria-expanded", "false");
      restorePanelFocus(panel, summaryPanelReturnFocus);
      summaryPanelReturnFocus = null;
    }
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
  function bind() {
    $("#newTab").onclick = () => setSidePanelView("launcher", "New tab");
    $("#reviewTab").onclick = () => openReviewPanel(state.activeReview);
    $("#utilityTab").onclick = () =>
      setSidePanelView($("#utilityTab").dataset.sidePanelTab, $("#utilityTab").textContent);
    $("#openSidePanelTab").onclick = () => setSidePanelView("launcher", "New tab");
    for (const action of document.querySelectorAll("[data-side-panel-action]"))
      action.onclick = () =>
        action.dataset.sidePanelAction === "review"
          ? openReviewPanel()
          : openUtilityPanel(action.dataset.sidePanelAction);
    $("#browserAddressForm").onsubmit = (event) => {
      event.preventDefault();
      navigateBrowser($("#browserUrl").value);
    };
    $("#browserBack").onclick = () => moveBrowserHistory(-1);
    $("#browserForward").onclick = () => moveBrowserHistory(1);
    $("#browserRefresh").onclick = () =>
      browserState.index >= 0 && navigateBrowser(browserState.history[browserState.index], { push: false });
    $("#toggleSummaryPanel").onclick = () => setSummaryPanelOpen($("#summaryPanel").hidden);
    $("#toggleFilesPanel").onclick = (...args) => toggleFilesPanel(...args);
    $("#closeFilesDialog").onclick = (...args) => closeFilesDialog(...args);
    filesDialog?.addEventListener("close", () => {
      filesPanel?.close();
      $("#filesPanel").hidden = true;
      $("#toggleFilesPanel").setAttribute("aria-expanded", "false");
      $("#toggleFilesPanel").setAttribute("aria-pressed", "false");
    });
    $("#toggleSidePanel").onclick = () => setSidePanelOpen($("#sidePanel").hidden);
    $("#closeSidePanel").onclick = () => setSidePanelOpen(false);
    $("#closeSummaryPanel").onclick = () => setSummaryPanelOpen(false);
  }
  return {
    setSummaryPanelOpen,
    closeFilesDialog,
    setSidePanelOpen,
    bind,
    openReviewPanel,
    openFilesDialog,
    setSidePanelView,
    openUsageSummary,
    navigateBrowser,
    browserState,
    filePreview,
    syncOverlayPanelMode,
    terminalStates,
    fitTerminal,
  };
}
