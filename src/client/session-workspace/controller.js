import { codexIcon } from "../codex-icons.js";
import { escapeHtml } from "../../shared/html.js";
import { closestElement, requireElement } from "../dom.js";
import { localizeAttribute, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { createSessionWorkspaceView } from "./view.js";
import { renderSessionUsage } from "./usage-view.js";
import { createSessionToolsView } from "./tools-view.js";

/** Owns layout and UI navigation; session/engine data arrives as a read-only projection. */
/** @param {import('../contracts/session-workspace.js').SessionWorkspaceOptions} options */
export function createSessionWorkspace(options) {
  const { t, i18n, read } = options;
  const { inspector, info, actions: actionButton, summary } = createSessionWorkspaceView(t);
  let desktop = matchMedia("(min-width:1050px)").matches;
  let desktopOpen = true,
    mobileOpen = false,
    desiredOpen = false,
    selectedTab = "overview";
  let activeId = "",
    executionSignature = "",
    controlLocation = "";
  let clock = 0;
  const controlHome = document.createComment("Session settings return here outside the desktop inspector");
  requireElement("#permissionPicker").before(controlHome);
  const goalHome = document.createComment("Goal status return location");
  requireElement("#goalStatus").before(goalHome);
  const details = requireElement("#summarySessionName").closest("section");
  const detailsHome = document.createComment("Session actions return to legacy summary outside a session");
  details?.before(detailsHome);
  const dialogs = [
    requireElement("#sessionUsageDialog"),
    requireElement("#sessionToolsDialog"),
    requireElement("#sessionActionsDialog"),
  ];
  const themeButton = requireElement('.workbench-top-tools [data-wb="theme"]');
  const themeHome = document.createComment("Theme action returns to the workspace header outside a session");
  themeButton.before(themeHome);
  setMessageHtml(themeButton, codexIcon("monitor") + messageHtml("common.toggleTheme", undefined, t));
  const tools = createSessionToolsView({
    registry: options.registry,
    store: options.store,
    t,
    openDialog,
    readSessionId: () => read().id,
    toast: options.toast,
  });
  function toggleClass(name, value) {
    if (document.body.classList.contains(name) !== value) document.body.classList.toggle(name, value);
  }
  function openDialog(dialog) {
    if (!dialog.open) {
      dialog.showModal();
      dialog.querySelector("h2")?.focus({ preventScroll: true });
    }
  }
  function placeControls(active) {
    const location = active && desktop ? "inspector" : "composer";
    if (location !== controlLocation) {
      controlLocation = location;
      const controls = [requireElement("#permissionPicker"), requireElement("#modelPicker")];
      if (location === "inspector") requireElement("#sessionConfiguration").append(...controls);
      else controlHome.after(...controls);
    }
    if (active) {
      if (requireElement("#goalStatus").parentElement !== requireElement("#sessionGoalSlot"))
        requireElement("#sessionGoalSlot").append(requireElement("#goalStatus"));
      if (details && details.parentElement !== requireElement("#sessionActionsContent"))
        requireElement("#sessionActionsContent").append(details);
      if (themeButton.parentElement !== requireElement("#sessionActionsContent"))
        requireElement("#sessionActionsContent").append(themeButton);
    } else {
      if (requireElement("#goalStatus").parentNode !== goalHome.parentNode)
        goalHome.after(requireElement("#goalStatus"));
      if (details && details.parentNode !== detailsHome.parentNode) detailsHome.after(details);
      if (themeButton.parentNode !== themeHome.parentNode) themeHome.after(themeButton);
    }
  }
  function setTab(tab, focus = false) {
    selectedTab = tab;
    const overview = tab === "overview";
    requireElement("#sessionOverview").hidden = !overview;
    requireElement("#sessionToolsView").hidden = overview;
    requireElement("#sessionInspectorFooter").hidden = !overview;
    for (const { id, selected } of [
      { id: "#sessionOverviewTab", selected: overview },
      { id: "#sessionToolsTab", selected: !overview },
    ]) {
      const button = requireElement(id);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    if (overview) tools.back();
  }
  function updateOpenState() {
    const active = options.isSessionPage() && Boolean(read().id);
    const utility =
      document.body.classList.contains("side-panel-open") ||
      document.body.classList.contains("summary-panel-open") ||
      document.body.classList.contains("files-workspace");
    desiredOpen = active && !utility && (desktop ? desktopOpen : mobileOpen);
    const modal = inspector.matches(":modal");
    if (inspector.open && (!desiredOpen || modal === desktop)) inspector.close();
    if (desiredOpen && !inspector.open) {
      if (desktop) {
        const focused = document.activeElement;
        inspector.show();
        if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body)
          focused.focus({ preventScroll: true });
      } else {
        inspector.showModal();
        requireElement("#sessionInspectorTitle").focus({ preventScroll: true });
      }
    }
    toggleClass("session-inspector-open", inspector.open && desktop);
    info.classList.toggle("active", inspector.open);
    info.setAttribute("aria-expanded", String(inspector.open));
  }
  function close() {
    if (desktop) desktopOpen = false;
    else mobileOpen = false;
    updateOpenState();
  }
  function open(tab = selectedTab) {
    options.beforeOpen();
    if (desktop) desktopOpen = true;
    else mobileOpen = true;
    setTab(tab);
    refresh();
  }
  function openUsage() {
    const view = read();
    renderSessionUsage(requireElement("#sessionUsageDialogContent"), view.usage, i18n);
    openDialog(requireElement("#sessionUsageDialog"));
  }
  function refresh() {
    const view = read(),
      active = options.isSessionPage() && Boolean(view.id);
    const changed = document.body.classList.contains("session-layout") !== active;
    toggleClass("session-layout", active);
    if (changed) options.layoutChanged();
    info.hidden = !active;
    actionButton.hidden = !active;
    summary.hidden = !active;
    for (const [id, controls] of [
      ["#modelButton", "modelMenu"],
      ["#modeButton", "permissionMenu"],
    ]) {
      const button = requireElement(id);
      button.setAttribute("aria-haspopup", active ? "dialog" : "menu");
      button.setAttribute("aria-controls", active ? "sessionSettingsDialog" : controls);
    }
    placeControls(active);
    if (view.id !== activeId || !active) {
      activeId = view.id;
      for (const dialog of dialogs) if (dialog.open) dialog.close();
      tools.back();
    }
    if (!active) {
      mobileOpen = false;
      window.clearInterval(clock);
      clock = 0;
      updateOpenState();
      return;
    }
    localizeAttribute(info, "aria-label", "sessionview.open", undefined, t);
    localizeAttribute(info, "title", "sessionview.open", undefined, t);
    localizeAttribute(actionButton, "aria-label", "sessionview.sessionActions", undefined, t);
    localizeAttribute(actionButton, "title", "sessionview.sessionActions", undefined, t);
    setOpaqueText(requireElement("#sessionProjectName"), view.project?.name || t("common.unassigned"));
    setOpaqueText(requireElement("#sessionProjectCode"), view.project?.code || "—");
    setOpaqueText(requireElement("#sessionWorkingFolder"), view.cwd || t("common.noWorkingFolder"));
    setOpaqueText(requireElement("#sessionMirrorModel"), view.modelLabel);
    setOpaqueText(requireElement("#sessionMirrorEffort"), view.effortLabel);
    setOpaqueText(requireElement("#sessionMirrorPermission"), view.permissionLabel);
    requireElement("#sessionWorkingFolder").title = view.cwd;
    const status = view.status;
    const signature = JSON.stringify([status, i18n.locale]);
    if (signature !== executionSignature) {
      executionSignature = signature;
      const slot = requireElement("#sessionExecutionSlot");
      slot.dataset.state = status?.state || "idle";
      setMessageHtml(
        slot,
        `<span class="session-execution-pill">${codexIcon(status?.icon || "info")}<span>${escapeHtml(status?.label || t("sessions.notStarted"))}</span></span>`,
      );
      setOpaqueText(requireElement("#sessionMobileStatus"), status?.label || t("sessions.notStarted"));
      requireElement("#sessionMobileStatusDot").dataset.state = status?.state || "idle";
    }
    const hints = {
      running: "sessionview.runningHint",
      completed: "sessionview.completedHint",
      approval: "sessionview.approvalHint",
      question: "sessionview.questionHint",
    };
    setOpaqueText(
      requireElement("#sessionExecutionHint"),
      status?.detail || t(hints[status?.state || ""] || "sessionview.idleHint"),
    );
    requireElement("#sessionPendingAction").hidden = !["approval", "question"].includes(status?.state || "");
    requireElement("#sessionGoalPlan").hidden = !view.hasGoal;
    updateClock(view);
    if (view.status?.state === "running" && !document.hidden) {
      if (!clock) clock = window.setInterval(() => updateClock(read()), 1000);
    } else {
      window.clearInterval(clock);
      clock = 0;
    }
    setOpaqueText(
      requireElement("#sessionMobileTokens"),
      view.usage.total === null
        ? "—"
        : i18n.format.number(view.usage.total, { notation: "compact", maximumFractionDigits: 1 }),
    );
    renderSessionUsage(requireElement("#sessionUsageView"), view.usage, i18n, { compact: true });
    if (requireElement("#sessionUsageDialog").open)
      renderSessionUsage(requireElement("#sessionUsageDialogContent"), view.usage, i18n);
    tools.render(i18n.locale);
    updateOpenState();
  }
  function updateClock(view) {
    const elapsed = view.elapsedMs === null ? "" : i18n.format.duration(view.elapsedMs);
    setOpaqueText(requireElement("#sessionElapsed"), elapsed);
    setOpaqueText(requireElement("#sessionMobileElapsed"), elapsed ? `· ${elapsed}` : "");
  }
  function activateTool(id) {
    if (id === "notes" || id === "checklist") {
      open("tools");
      tools.activate(id);
    } else {
      if (!desktop) close();
      tools.activate(id);
    }
  }
  function click(event) {
    if (!owns(event.target)) return;
    const target = closestElement("[data-session-action]", event.target);
    const action = target?.dataset.sessionAction;
    if (action === "open") open();
    if (action === "close") close();
    if (action === "overview" || action === "tools") setTab(action);
    if (action === "back-tools") tools.back();
    if (action === "customize") tools.manager();
    if (action === "project") {
      if (!desktop) close();
      options.associateProject();
    }
    if (action === "usage") openUsage();
    if (action === "pending") {
      if (!desktop) close();
      options.pendingAction();
    }
    if (action === "model" || action === "permissions") options.openSettings(action);
    const tool = closestElement("[data-session-tool]", event.target);
    if (tool) activateTool(tool.dataset.sessionTool);
    const dismiss = closestElement("[data-session-dismiss]", event.target);
    if (dismiss) dismiss.closest("dialog")?.close();
    tools.click(event);
  }
  function owns(target) {
    return (
      target instanceof Node &&
      (inspector.contains(target) || summary.contains(target) || dialogs.some((dialog) => dialog.contains(target)))
    );
  }
  function bind() {
    requireElement("#sessionWorkspaceSearch").onclick = options.search;
    info.onclick = () => (inspector.open ? close() : open());
    actionButton.onclick = () => {
      options.openSessionActions();
      openDialog(requireElement("#sessionActionsDialog"));
    };
    for (const id of ["#modelButton", "#modeButton"])
      requireElement(id).addEventListener(
        "click",
        (event) => {
          if (!options.isSessionPage() || !read().id) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          options.openSettings(id === "#modelButton" ? "model" : "permissions");
        },
        true,
      );
    document.addEventListener("click", click);
    document.addEventListener("change", (event) => {
      if (owns(event.target)) tools.change(event);
    });
    document.addEventListener("input", (event) => {
      if (owns(event.target)) tools.input(event);
    });
    document.addEventListener("submit", (event) => {
      if (owns(event.target)) tools.submit(event);
    });
    requireElement(".session-inspector-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setTab(
        event.key === "Home"
          ? "overview"
          : event.key === "End"
            ? "tools"
            : selectedTab === "overview"
              ? "tools"
              : "overview",
        true,
      );
    });
    for (const dialog of [inspector, ...dialogs])
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog || (dialog === inspector && desktop)) return;
        const bounds = dialog.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dialog.close();
      });
    inspector.addEventListener("close", () => {
      if (inspector.open) return;
      if (desiredOpen) {
        if (desktop) desktopOpen = false;
        else mobileOpen = false;
      }
      desiredOpen = false;
      toggleClass("session-inspector-open", false);
      info.classList.remove("active");
      info.setAttribute("aria-expanded", "false");
    });
    matchMedia("(min-width:1050px)").addEventListener("change", (event) => {
      desktop = event.matches;
      refresh();
    });
    i18n.subscribe(() => {
      refresh();
      if (requireElement("#sessionToolsDialog").open) tools.manager();
    });
    document.addEventListener("visibilitychange", refresh);
    addEventListener("pagehide", () => {
      window.clearInterval(clock);
      clock = 0;
    });
    addEventListener("pageshow", refresh);
    refresh();
  }
  return { bind, refresh, open, close, openUsage };
}
