import { creationSessionRoute } from "../creation/session-route.js";
import { createSessionWorkspace } from "../session-workspace/controller.js";
import { createSessionSettingsDialog } from "../session-workspace/settings-dialog.js";
import { createComposerSettingsMenu } from "../session-workspace/composer-settings.js";
import { createSessionToolRegistry } from "../session-workspace/tool-registry.js";
import { createSessionToolStorage } from "../session-workspace/tool-storage.js";
import { sessionUsageView } from "../session-workspace/usage.js";
import { parseWorkbenchRoute } from "../workbench-route.js";
import { findElement } from "../dom.js";

/** The inspector consumes domain projections and invokes named capabilities, never engine RPCs. */
/** @param {import('./ports.js').FeatureOptions<'state' | 'identity' | 't' | 'i18n', 'sidebarLayout' | 'models' | 'status' | 'approvals' | 'projects' | 'workbench' | 'panels' | 'details' | 'timing' | 'notices', 'sessionWorkspace'>} options */
export function assembleSessionWorkspace({
  state,
  identity,
  t,
  i18n,
  modelsPort,
  statusPort,
  approvalsPort,
  projectsPort,
  workbenchPort,
  panelsPort,
  detailsPort,
  timingPort,
  noticesPort,
  sidebarLayoutPort,
}) {
  const creation = () => (creationSessionRoute() ? workbenchPort.workbench?.creationSession() || null : null);
  const isSessionPage = () => {
    if (creation()) return true;
    const route = parseWorkbenchRoute();
    return route.page === "task" && route.id === state.active?.id;
  };
  const settings = createSessionSettingsDialog({
    t,
    read: () => creation()?.controls() || modelsPort.sessionControlView(),
    applyModel: (id, model, effort) => {
      const domain = creation();
      if (domain) {
        if (domain.key !== id) throw new Error(t("sessionview.sessionChanged"));
        domain.applyModel(model, effort);
        panel.refresh();
      } else modelsPort.applyModelSelection(id, model, effort);
    },
    applyRuntimeModel: (id, selection, runtime) => {
      const domain = creation();
      if (!domain) return modelsPort.applyRuntimeModel(id, selection, runtime);
      if (domain.key !== id) throw new Error(t("sessionview.sessionChanged"));
      domain.applyRuntimeSelection(selection, runtime);
      panel.refresh();
    },
    applyPermission: (...args) => modelsPort.applyPermissionSelection(...args),
    reloadModels: () => modelsPort.loadModels(),
    onError: (message) => noticesPort.addPersistentError(message),
  });
  modelsPort.setModelPicker(() => settings.open("model"));
  const composerSettings = createComposerSettingsMenu({
    t,
    read: () => creation()?.controls() || modelsPort.sessionControlView(),
    context: () => creation()?.key || state.active?.id || `new:${state.newSessionProjectId || "personal"}`,
    beforeOpen: () => {
      modelsPort.closeModelMenu();
      modelsPort.closePermissionMenu();
    },
    openDetail: (kind, navigation) => {
      if (
        kind === "model" ||
        creation() ||
        (isSessionPage() && state.active?.id) ||
        (kind === "permissions" && modelsPort.sessionControlView().permissionOwner === "harness")
      )
        settings.open(kind, navigation);
      else modelsPort.openPermissionMenu(navigation.back);
    },
  });
  i18n.subscribe(() => composerSettings.sync());
  const registry = createSessionToolRegistry([
    {
      id: "files",
      title: "common.files",
      description: "sessionview.filesHint",
      icon: "folderOpen",
      enabled: true,
      activate: () => panelsPort.openFilesDialog(),
    },
    {
      id: "changes",
      title: "sessionview.changes",
      description: "sessionview.changesHint",
      icon: "gitBranch",
      enabled: true,
      activate: () => panelsPort.openReviewPanel(),
    },
    {
      id: "terminal",
      title: "common.terminal",
      description: "sessionview.terminalHint",
      icon: "terminal",
      enabled: true,
      activate: () => panelsPort.openUtilityPanel("terminal"),
    },
    {
      id: "notes",
      title: "sessionview.notes",
      description: "sessionview.notesHint",
      icon: "file",
      enabled: true,
      activate: () => {},
    },
    {
      id: "checklist",
      title: "sessionview.checklist",
      description: "sessionview.checklistHint",
      icon: "list",
      enabled: false,
      activate: () => {},
    },
    {
      id: "browser",
      title: "common.browser",
      description: "sessionview.browserHint",
      icon: "globe",
      enabled: true,
      activate: () => panelsPort.openUtilityPanel("browser"),
    },
    {
      id: "side-tasks",
      title: "common.sideTasks",
      description: "sessionview.sideTasksHint",
      icon: "messageSquare",
      enabled: true,
      activate: () => panelsPort.openUtilityPanel("side-task"),
    },
  ]);
  const store = createSessionToolStorage(registry, identity);
  function pendingQuestion() {
    return (
      [...state.items.values()].find((element) => element.matches('[data-async-question-card][data-status="open"]')) ||
      null
    );
  }
  /** @returns {import('../contracts/session-workspace.js').SessionWorkspaceView} */
  function read() {
    const domain = creation();
    if (domain) return domain.read();
    const active = state.active,
      id = active?.id || "";
    const project = id ? projectsPort.businessProjects.projectForSession(id) : null;
    const baseStatus = statusPort.deriveSessionStatus();
    const pending = id ? approvalsPort.pendingInteraction(id) || (pendingQuestion() ? "question" : null) : null;
    const status = pending
      ? {
          state: pending,
          label: t(pending === "approval" ? "sessionview.approvalNeeded" : "sessionview.answerNeeded"),
          detail: "",
          icon: pending === "approval" ? "shield" : "messageSquare",
        }
      : baseStatus;
    const last = active?.turns?.at(-1);
    const turnId = statusPort.sessionRuntime.activeTurnId(active) || last?.id;
    const turn = active?.turns?.find((turn) => turn.id === turnId);
    const timing = turnId ? state.turnTimings.get(turnId) : undefined;
    const duration = timingPort.turnDurationMs(turn);
    const elapsedMs =
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0
        ? duration
        : timing?.started
          ? Math.max(0, ((timing.completed || Date.now() / 1000) - timing.started) * 1000)
          : null;
    const controls = modelsPort.sessionControlView();
    const model = controls.models.find((model) => model.id === controls.model);
    const goal = id ? state.goals.get(id) : undefined;
    return {
      id,
      title: active?.name || active?.preview || "",
      cwd: active?.projectless ? "" : active?.cwd || "",
      project: project ? { id: project.id, name: project.name, code: project.code } : null,
      status,
      elapsedMs,
      usage: sessionUsageView(id ? state.tokenUsage.get(id) : undefined),
      hasGoal: Boolean(id && state.goals.has(id)),
      goal: goal ? { id: goal.goalId, status: goal.status } : null,
      modelLabel: model?.label || t("workbench.modelUnavailable"),
      effortLabel: modelsPort.reasoningLabel(controls.effort),
      permissionLabel: controls.permissions.find((option) => option.id === controls.permission)?.label || "",
    };
  }
  const panel = createSessionWorkspace({
    t,
    i18n,
    read,
    renderSections: (host) => creation()?.renderSections(host),
    isSessionPage,
    registry,
    store,
    associateProject: () => {
      if (state.active?.id)
        void workbenchPort.workbench
          ?.associateSession(state.active.id)
          .catch((error) => noticesPort.addPersistentError(error));
    },
    openSettings: (kind) => {
      modelsPort.closeModelMenu();
      modelsPort.closePermissionMenu();
      settings.open(kind);
    },
    openSessionActions: () => detailsPort.syncSummaryPanel(),
    beforeOpen: () => {
      panelsPort.closeFilesDialog();
      panelsPort.setSidePanelOpen(false, false);
      panelsPort.setSummaryPanelOpen(false);
    },
    pendingAction: () => {
      if (creation()) {
        const card = document.querySelector(".creation-session-status .user-input-card");
        if (card) {
          card.scrollIntoView({ block: "center" });
          findElement("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)", card)?.focus({
            preventScroll: true,
          });
        }
        return;
      }
      const card = approvalsPort.pendingCard(state.active?.id || "") || pendingQuestion();
      if (!card) return;
      if (card instanceof HTMLDetailsElement) card.open = true;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      findElement("button:not(:disabled), input:not(:disabled)", card)?.focus({ preventScroll: true });
    },
    toast: (message) => noticesPort.toast(message),
    search: () => {
      if (sidebarLayoutPort.mobileSidebarEnabled()) sidebarLayoutPort.setSidebarOpen(false);
      workbenchPort.workbench?.openSearch();
    },
    layoutChanged: () => sidebarLayoutPort.syncSidebarLayout(),
  });
  return {
    bind: panel.bind,
    open: panel.open,
    isOpen: panel.isOpen,
    setOpen: panel.setOpen,
    close: panel.close,
    openUsage: panel.openUsage,
    openSettings: (kind) => settings.open(kind),
    refresh() {
      settings.sync();
      if (!isSessionPage() && parseWorkbenchRoute().page !== "new") settings.close();
      panel.refresh();
      composerSettings.sync();
    },
  };
}
