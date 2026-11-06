import { createFeaturePort, installFeature as install } from "./application/composition.js";
// Composition root. Read/write grants are supplied per feature, never shared as a writable global.
import { assembleApplicationProjections } from "./application/application-projections.js";
import { assembleBindings } from "./application/bindings.js";
import { assembleClipboard } from "./application/clipboard.js";
import { assembleCommands } from "./application/commands.js";
import { assembleComposerInteractions } from "./application/composer-interactions.js";
import { assembleComposer } from "./application/composer.js";
import { assembleConnection } from "./application/connection.js";
import { assembleDelivery } from "./application/delivery.js";
import { assembleDetails } from "./application/details.js";
import { assembleDiagnostics } from "./application/diagnostics.js";
import { assembleApprovals, assembleGoals, assembleModels, assembleStatus } from "./application/engine-services.js";
import { assembleEnvironment } from "./application/environment.js";
import { assembleHistory } from "./application/history.js";
import { assembleIdentity } from "./application/identity.js";
import { assembleImages } from "./application/images.js";
import { assembleInputSessions } from "./application/input-sessions.js";
import {
  assembleAccount,
  assembleActivity,
  assembleReview,
  assembleSettings,
  assembleUploads,
  assembleUsage,
} from "./application/interface-services.js";
import { assembleLocalization } from "./application/localization.js";
import { assembleMessages } from "./application/messages.js";
import { assembleNavigation } from "./application/navigation.js";
import { assembleNotices } from "./application/notices.js";
import { assembleNotifications } from "./application/notifications.js";
import { assemblePanels } from "./application/panels.js";
import { assembleQueue } from "./application/queue.js";
import { assembleRepositories } from "./application/repositories.js";
import { assembleSideTasks } from "./application/side-tasks.js";
import { assembleSidebarLayout } from "./application/sidebar-layout.js";
import { assembleStartup } from "./application/startup.js";
import { assembleSubmission } from "./application/submission.js";
import { assembleSuggestions } from "./application/suggestions.js";
import { assembleSynchronization } from "./application/synchronization.js";
import { assembleTimeline } from "./application/timeline.js";
import { assembleTiming } from "./application/timing.js";
import { assembleTransport } from "./application/transport-service.js";
import { assembleTurnFrames } from "./application/turn-frames.js";
import { assembleViewport } from "./application/viewport.js";
import { assembleProjects, assembleSidebar, assembleWorkbench } from "./application/workspace-services.js";
import { assembleWorkspace } from "./application/workspace.js";
import { assembleWorkbenchChrome } from "./application/workbench-chrome.js";
import { assembleSessionWorkspace } from "./application/session-workspace.js";
export function startApplication() {
  const sessionWorkspace = /** @type {import('./application/ports.js').ApplicationPorts['sessionWorkspace']} */ (
    createFeaturePort("sessionWorkspace")
  );
  const environment = /** @type {import("./application/ports.js").ApplicationPorts["environment"]} */ (
    createFeaturePort("environment")
  );
  const localization = /** @type {import("./application/ports.js").ApplicationPorts["localization"]} */ (
    createFeaturePort("localization")
  );
  const history = /** @type {import("./application/ports.js").ApplicationPorts["history"]} */ (
    createFeaturePort("history")
  );
  const queue = /** @type {import("./application/ports.js").ApplicationPorts["queue"]} */ (createFeaturePort("queue"));
  const status = /** @type {import("./application/ports.js").ApplicationPorts["status"]} */ (
    createFeaturePort("status")
  );
  const goals = /** @type {import("./application/ports.js").ApplicationPorts["goals"]} */ (createFeaturePort("goals"));
  const approvals = /** @type {import("./application/ports.js").ApplicationPorts["approvals"]} */ (
    createFeaturePort("approvals")
  );
  const models = /** @type {import("./application/ports.js").ApplicationPorts["models"]} */ (
    createFeaturePort("models")
  );
  const composer = /** @type {import("./application/ports.js").ApplicationPorts["composer"]} */ (
    createFeaturePort("composer")
  );
  const details = /** @type {import("./application/ports.js").ApplicationPorts["details"]} */ (
    createFeaturePort("details")
  );
  const timing = /** @type {import("./application/ports.js").ApplicationPorts["timing"]} */ (
    createFeaturePort("timing")
  );
  const startup = /** @type {import("./application/ports.js").ApplicationPorts["startup"]} */ (
    createFeaturePort("startup")
  );
  const viewport = /** @type {import("./application/ports.js").ApplicationPorts["viewport"]} */ (
    createFeaturePort("viewport")
  );
  const notices = /** @type {import("./application/ports.js").ApplicationPorts["notices"]} */ (
    createFeaturePort("notices")
  );
  const navigation = /** @type {import("./application/ports.js").ApplicationPorts["navigation"]} */ (
    createFeaturePort("navigation")
  );
  const commands = /** @type {import("./application/ports.js").ApplicationPorts["commands"]} */ (
    createFeaturePort("commands")
  );
  const sideTasks = /** @type {import("./application/ports.js").ApplicationPorts["sideTasks"]} */ (
    createFeaturePort("sideTasks")
  );
  const turnFrames = /** @type {import("./application/ports.js").ApplicationPorts["turnFrames"]} */ (
    createFeaturePort("turnFrames")
  );
  const connection = /** @type {import("./application/ports.js").ApplicationPorts["connection"]} */ (
    createFeaturePort("connection")
  );
  const timeline = /** @type {import("./application/ports.js").ApplicationPorts["timeline"]} */ (
    createFeaturePort("timeline")
  );
  const transport = /** @type {import("./application/ports.js").ApplicationPorts["transport"]} */ (
    createFeaturePort("transport")
  );
  const review = /** @type {import("./application/ports.js").ApplicationPorts["review"]} */ (
    createFeaturePort("review")
  );
  const activity = /** @type {import("./application/ports.js").ApplicationPorts["activity"]} */ (
    createFeaturePort("activity")
  );
  const uploads = /** @type {import("./application/ports.js").ApplicationPorts["uploads"]} */ (
    createFeaturePort("uploads")
  );
  const usage = /** @type {import("./application/ports.js").ApplicationPorts["usage"]} */ (createFeaturePort("usage"));
  const settings = /** @type {import("./application/ports.js").ApplicationPorts["settings"]} */ (
    createFeaturePort("settings")
  );
  const account = /** @type {import("./application/ports.js").ApplicationPorts["account"]} */ (
    createFeaturePort("account")
  );
  const images = /** @type {import("./application/ports.js").ApplicationPorts["images"]} */ (
    createFeaturePort("images")
  );
  const clipboard = /** @type {import("./application/ports.js").ApplicationPorts["clipboard"]} */ (
    createFeaturePort("clipboard")
  );
  const panels = /** @type {import("./application/ports.js").ApplicationPorts["panels"]} */ (
    createFeaturePort("panels")
  );
  const bindings = /** @type {import("./application/ports.js").ApplicationPorts["bindings"]} */ (
    createFeaturePort("bindings")
  );
  const diagnostics = /** @type {import("./application/ports.js").ApplicationPorts["diagnostics"]} */ (
    createFeaturePort("diagnostics")
  );
  const notifications = /** @type {import("./application/ports.js").ApplicationPorts["notifications"]} */ (
    createFeaturePort("notifications")
  );
  const suggestions = /** @type {import("./application/ports.js").ApplicationPorts["suggestions"]} */ (
    createFeaturePort("suggestions")
  );
  const submission = /** @type {import("./application/ports.js").ApplicationPorts["submission"]} */ (
    createFeaturePort("submission")
  );
  const messages = /** @type {import("./application/ports.js").ApplicationPorts["messages"]} */ (
    createFeaturePort("messages")
  );
  const delivery = /** @type {import("./application/ports.js").ApplicationPorts["delivery"]} */ (
    createFeaturePort("delivery")
  );
  const sidebarLayout = /** @type {import("./application/ports.js").ApplicationPorts["sidebarLayout"]} */ (
    createFeaturePort("sidebarLayout")
  );
  const synchronization = /** @type {import("./application/ports.js").ApplicationPorts["synchronization"]} */ (
    createFeaturePort("synchronization")
  );
  const workspace = /** @type {import("./application/ports.js").ApplicationPorts["workspace"]} */ (
    createFeaturePort("workspace")
  );
  const repositories = /** @type {import("./application/ports.js").ApplicationPorts["repositories"]} */ (
    createFeaturePort("repositories")
  );
  const inputSessions = /** @type {import("./application/ports.js").ApplicationPorts["inputSessions"]} */ (
    createFeaturePort("inputSessions")
  );
  const identity = /** @type {import("./application/ports.js").ApplicationPorts["identity"]} */ (
    createFeaturePort("identity")
  );
  const projects = /** @type {import("./application/ports.js").ApplicationPorts["projects"]} */ (
    createFeaturePort("projects")
  );
  const sidebar = /** @type {import("./application/ports.js").ApplicationPorts["sidebar"]} */ (
    createFeaturePort("sidebar")
  );
  const composerInteractions =
    /** @type {import("./application/ports.js").ApplicationPorts["composerInteractions"]} */ (
      createFeaturePort("composerInteractions")
    );
  const workbench = /** @type {import("./application/ports.js").ApplicationPorts["workbench"]} */ (
    createFeaturePort("workbench")
  );
  const applicationProjections =
    /** @type {import("./application/ports.js").ApplicationPorts["applicationProjections"]} */ (
      createFeaturePort("applicationProjections")
    );
  install(environment, assembleEnvironment());
  install(
    localization,
    assembleLocalization({
      viewUpdates: environment.viewUpdates,
      $: environment.$,
      i18n: environment.i18n,
      state: environment.stateFor("localization").state,
      t: environment.t,
      workspacePort: workspace,
      accountPort: account,
      modelsPort: models,
      usagePort: usage,
      noticesPort: notices,
      settingsPort: settings,
    }),
  );
  install(
    history,
    assembleHistory({
      transportPort: transport,
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("history").mutations,
      sessions: environment.sessions,
      $: environment.$,
      t: environment.t,
      state: environment.stateFor("history").state,
      repositoriesPort: repositories,
      noticesPort: notices,
    }),
  );
  install(
    queue,
    assembleQueue({
      transportPort: transport,
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("queue").mutations,
      $: environment.$,
      t: environment.t,
      state: environment.stateFor("queue").state,
      deliveryPort: delivery,
      noticesPort: notices,
      uploadsPort: uploads,
      composerPort: composer,
      modelsPort: models,
      suggestionsPort: suggestions,
      inputSessionsPort: inputSessions,
    }),
  );
  install(
    status,
    assembleStatus({
      viewUpdates: environment.viewUpdates,
      $: environment.$,
      t: environment.t,
      i18n: environment.i18n,
      titleOf: environment.titleOf,
      shortPath: environment.shortPath,
      escapeHtml: environment.escapeHtml,
      state: environment.stateFor("status").state,
      mutations: environment.stateFor("status").mutations,
    }),
  );
  install(
    goals,
    assembleGoals({
      viewUpdates: environment.viewUpdates,
      transportPort: transport,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      timingPort: timing,
      noticesPort: notices,
      state: environment.stateFor("goals").state,
      mutations: environment.stateFor("goals").mutations,
    }),
  );
  install(
    approvals,
    assembleApprovals({
      transportPort: transport,
      turnFramesPort: turnFrames,
      viewUpdates: environment.viewUpdates,
      i18n: environment.i18n,
      $: environment.$,
      t: environment.t,
      state: environment.stateFor("approvals").state,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      noticesPort: notices,
      activityPort: activity,
      viewportPort: viewport,
      reviewPort: review,
      panelsPort: panels,
      mutations: environment.stateFor("approvals").mutations,
    }),
  );
  install(
    models,
    assembleModels({
      viewUpdates: environment.viewUpdates,
      transportPort: transport,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      workspacePreparation: environment.workspacePreparation,
      noticesPort: notices,
      state: environment.stateFor("models").state,
      mutations: environment.stateFor("models").mutations,
    }),
  );
  install(
    composer,
    assembleComposer({
      drafts: environment.drafts,
      mutations: environment.stateFor("composer").mutations,
      state: environment.stateFor("composer").state,
      $: environment.$,
      t: environment.t,
      uploadsPort: uploads,
      statusPort: status,
      deliveryPort: delivery,
      viewUpdates: environment.viewUpdates,
      modelsPort: models,
    }),
  );
  install(
    details,
    assembleDetails({
      sessions: environment.sessions,
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("details").mutations,
      t: environment.t,
      state: environment.stateFor("details").state,
      $: environment.$,
      modelsPort: models,
      clipboardPort: clipboard,
      noticesPort: notices,
    }),
  );
  install(
    timing,
    assembleTiming({
      renderBatch: environment.renderBatch,
      mutations: environment.stateFor("timing").mutations,
      i18n: environment.i18n,
      state: environment.stateFor("timing").state,
      t: environment.t,
    }),
  );
  install(
    startup,
    assembleStartup({
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("startup").mutations,
      sessions: environment.sessions,
      workspacePreparation: environment.workspacePreparation,
      state: environment.stateFor("startup").state,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      t: environment.t,
      accountPort: account,
      approvalsPort: approvals,
      composerPort: composer,
      sidebarPort: sidebar,
      panelsPort: panels,
      usagePort: usage,
      modelsPort: models,
      navigationPort: navigation,
      synchronizationPort: synchronization,
      noticesPort: notices,
      repositoriesPort: repositories,
      suggestionsPort: suggestions,
      projectsPort: projects,
      sidebarLayoutPort: sidebarLayout,
      workspacePort: workspace,
      settingsPort: settings,
      statusPort: status,
      configurationReadiness: environment.configurationReadiness,
    }),
  );
  install(viewport, assembleViewport({ $: environment.$ }));
  install(
    notices,
    assembleNotices({
      mutations: environment.stateFor("notices").mutations,
      $: environment.$,
      state: environment.stateFor("notices").state,
      t: environment.t,
    }),
  );
  install(
    navigation,
    assembleNavigation({
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("navigation").mutations,
      sessions: environment.sessions,
      state: environment.stateFor("navigation").state,
      $: environment.$,
      t: environment.t,
      projectsPort: projects,
      composerPort: composer,
      goalsPort: goals,
      synchronizationPort: synchronization,
      timelinePort: timeline,
      reviewPort: review,
      suggestionsPort: suggestions,
      modelsPort: models,
      statusPort: status,
      viewportPort: viewport,
      historyPort: history,
      repositoriesPort: repositories,
      queuePort: queue,
      noticesPort: notices,
      configurationReadiness: environment.configurationReadiness,
    }),
  );
  install(
    commands,
    assembleCommands({
      sessionWorkspacePort: sessionWorkspace,
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      sessions: environment.sessions,
      state: environment.stateFor("commands").state,
      $: environment.$,
      t: environment.t,
      composerPort: composer,
      modelsPort: models,
      workspacePort: workspace,
      noticesPort: notices,
      navigationPort: navigation,
      goalsPort: goals,
    }),
  );
  install(
    sideTasks,
    assembleSideTasks({
      renderBatch: environment.renderBatch,
      mutations: environment.stateFor("sideTasks").mutations,
      state: environment.stateFor("sideTasks").state,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      navigationPort: navigation,
    }),
  );
  install(
    turnFrames,
    assembleTurnFrames({
      state: environment.stateFor("turnFrames").state,
      mutations: environment.stateFor("turnFrames").mutations,
      $: environment.$,
    }),
  );
  install(
    connection,
    assembleConnection({
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("connection").mutations,
      state: environment.stateFor("connection").state,
      workspacePreparation: environment.workspacePreparation,
      t: environment.t,
      $: environment.$,
      startupPort: startup,
      synchronizationPort: synchronization,
      sidebarPort: sidebar,
      notificationsPort: notifications,
      historyPort: history,
      approvalsPort: approvals,
      projectsPort: projects,
      modelsPort: models,
      usagePort: usage,
    }),
  );
  install(
    timeline,
    assembleTimeline({
      renderBatch: environment.renderBatch,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("timeline").mutations,
      state: environment.stateFor("timeline").state,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      statusPort: status,
      viewportPort: viewport,
      historyPort: history,
      noticesPort: notices,
      queuePort: queue,
      timingPort: timing,
      messagesPort: messages,
    }),
  );
  install(
    transport,
    assembleTransport({
      t: environment.t,
      state: environment.stateFor("transport").state,
      mutations: environment.stateFor("transport").mutations,
    }),
  );
  install(
    review,
    assembleReview({
      renderBatch: environment.renderBatch,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      noticesPort: notices,
      panelsPort: panels,
      state: environment.stateFor("review").state,
      mutations: environment.stateFor("review").mutations,
    }),
  );
  install(
    activity,
    assembleActivity({
      turnFramesPort: turnFrames,
      renderBatch: environment.renderBatch,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      identityPort: identity,
      timingPort: timing,
      state: environment.stateFor("activity").state,
      mutations: environment.stateFor("activity").mutations,
    }),
  );
  install(
    uploads,
    assembleUploads({
      drafts: environment.drafts,
      viewUpdates: environment.viewUpdates,
      $: environment.$,
      t: environment.t,
      imagesPort: images,
      noticesPort: notices,
      state: environment.stateFor("uploads").state,
      mutations: environment.stateFor("uploads").mutations,
    }),
  );
  install(
    usage,
    assembleUsage({
      transportPort: transport,
      $: environment.$,
      t: environment.t,
      i18n: environment.i18n,
      state: environment.stateFor("usage").state,
      mutations: environment.stateFor("usage").mutations,
    }),
  );
  install(
    settings,
    assembleSettings({
      $: environment.$,
      t: environment.t,
      shortPath: environment.shortPath,
      modelsPort: models,
      panelsPort: panels,
      viewUpdates: environment.viewUpdates,
      state: environment.stateFor("settings").state,
      mutations: environment.stateFor("settings").mutations,
    }),
  );
  install(
    account,
    assembleAccount({
      $: environment.$,
      t: environment.t,
      state: environment.stateFor("account").state,
      settingsPort: settings,
      modelsPort: models,
      panelsPort: panels,
      usagePort: usage,
      mutations: environment.stateFor("account").mutations,
    }),
  );
  install(images, assembleImages({ $: environment.$ }));
  install(clipboard, assembleClipboard({ t: environment.t, noticesPort: notices }));
  install(
    panels,
    assemblePanels({
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("panels").mutations,
      t: environment.t,
      shortPath: environment.shortPath,
      $: environment.$,
      state: environment.stateFor("panels").state,
      noticesPort: notices,
      workspacePort: workspace,
      settingsPort: settings,
      usagePort: usage,
    }),
  );
  install(
    bindings,
    assembleBindings({
      i18n: environment.i18n,
      $: environment.$,
      workspacePreparation: environment.workspacePreparation,
      state: environment.stateFor("bindings").state,
      imagesPort: images,
      panelsPort: panels,
      localizationPort: localization,
      synchronizationPort: synchronization,
      sidebarLayoutPort: sidebarLayout,
      usagePort: usage,
      identityPort: identity,
      modelsPort: models,
      viewUpdates: environment.viewUpdates,
      settingsPort: settings,
      workbenchPort: workbench,
      navigationPort: navigation,
    }),
  );
  install(
    diagnostics,
    assembleDiagnostics({
      viewUpdates: environment.viewUpdates,
      stateDomains: environment.stateDomains,
      state: environment.stateFor("diagnostics").state,
      statusPort: status,
      workbenchPort: workbench,
      repositoriesPort: repositories,
      notificationsPort: notifications,
      approvalsPort: approvals,
      panelsPort: panels,
      synchronizationPort: synchronization,
      reviewPort: review,
      accountPort: account,
      workspacePort: workspace,
      imagesPort: images,
      navigationPort: navigation,
      startupPort: startup,
      sidebarLayoutPort: sidebarLayout,
      settingsPort: settings,
      modelsPort: models,
      viewportPort: viewport,
    }),
  );
  install(
    notifications,
    assembleNotifications({
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("notifications").mutations,
      sessions: environment.sessions,
      state: environment.stateFor("notifications").state,
      $: environment.$,
      messagesPort: messages,
      modelsPort: models,
      statusPort: status,
      noticesPort: notices,
      queuePort: queue,
      timingPort: timing,
      goalsPort: goals,
      approvalsPort: approvals,
      synchronizationPort: synchronization,
      usagePort: usage,
      accountPort: account,
      composerPort: composer,
      identityPort: identity,
      viewportPort: viewport,
      reviewPort: review,
    }),
  );
  install(
    suggestions,
    assembleSuggestions({
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("suggestions").mutations,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      state: environment.stateFor("suggestions").state,
      titleOf: environment.titleOf,
      shortPath: environment.shortPath,
      t: environment.t,
      workspacePort: workspace,
      modelsPort: models,
      composerPort: composer,
      noticesPort: notices,
      commandsPort: commands,
    }),
  );
  install(
    submission,
    assembleSubmission({
      transportPort: transport,
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("submission").mutations,
      state: environment.stateFor("submission").state,
      t: environment.t,
      $: environment.$,
      deliveryPort: delivery,
      suggestionsPort: suggestions,
      modelsPort: models,
      composerPort: composer,
      commandsPort: commands,
      uploadsPort: uploads,
      noticesPort: notices,
      synchronizationPort: synchronization,
      inputSessionsPort: inputSessions,
    }),
  );
  install(
    messages,
    assembleMessages({
      turnFramesPort: turnFrames,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("messages").mutations,
      $: environment.$,
      state: environment.stateFor("messages").state,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      identityPort: identity,
      sideTasksPort: sideTasks,
      viewportPort: viewport,
      activityPort: activity,
      submissionPort: submission,
      queuePort: queue,
      timingPort: timing,
      clipboardPort: clipboard,
      reviewPort: review,
    }),
  );
  install(
    delivery,
    assembleDelivery({
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      state: environment.stateFor("delivery").state,
      $: environment.$,
    }),
  );
  install(
    sidebarLayout,
    assembleSidebarLayout({
      viewUpdates: environment.viewUpdates,
      $: environment.$,
      noticesPort: notices,
      t: environment.t,
      settingsPort: settings,
    }),
  );
  install(
    synchronization,
    assembleSynchronization({
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      sessions: environment.sessions,
      state: environment.stateFor("synchronization").state,
      workspacePreparation: environment.workspacePreparation,
      $: environment.$,
      statusPort: status,
      repositoriesPort: repositories,
      modelsPort: models,
      queuePort: queue,
      historyPort: history,
      timingPort: timing,
      timelinePort: timeline,
      composerPort: composer,
      viewportPort: viewport,
    }),
  );
  install(
    workspace,
    assembleWorkspace({
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("workspace").mutations,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      state: environment.stateFor("workspace").state,
      t: environment.t,
      shortPath: environment.shortPath,
      titleOf: environment.titleOf,
      timelinePort: timeline,
      modelsPort: models,
      composerPort: composer,
      navigationPort: navigation,
      projectsPort: projects,
      goalsPort: goals,
      queuePort: queue,
    }),
  );
  install(
    repositories,
    assembleRepositories({
      mutations: environment.stateFor("repositories").mutations,
      sessions: environment.sessions,
      identity: environment.identityKey,
    }),
  );
  install(
    inputSessions,
    assembleInputSessions({
      transportPort: transport,
      selection: environment.selection,
      viewUpdates: environment.viewUpdates,
      sessions: environment.sessions,
      state: environment.stateFor("inputSessions").state,
      navigationPort: navigation,
      workspacePort: workspace,
      projectsPort: projects,
      deliveryPort: delivery,
    }),
  );
  install(
    identity,
    assembleIdentity({
      mutations: environment.stateFor("identity").mutations,
      deliveryPort: delivery,
      state: environment.stateFor("identity").state,
    }),
  );
  install(
    projects,
    assembleProjects({
      viewUpdates: environment.viewUpdates,
      state: environment.stateFor("projects").state,
      mutations: environment.stateFor("projects").mutations,
    }),
  );
  install(
    sidebar,
    assembleSidebar({
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("sidebar").mutations,
      sessions: environment.sessions,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      titleOf: environment.titleOf,
      workspacePreparation: environment.workspacePreparation,
      projectsPort: projects,
      repositoriesPort: repositories,
      navigationPort: navigation,
      workbenchPort: workbench,
      workspacePort: workspace,
      sidebarLayoutPort: sidebarLayout,
      statusPort: status,
      commandsPort: commands,
      noticesPort: notices,
      synchronizationPort: synchronization,
      state: environment.stateFor("sidebar").state,
    }),
  );
  install(
    composerInteractions,
    assembleComposerInteractions({
      mutations: environment.stateFor("composerInteractions").mutations,
      state: environment.stateFor("composerInteractions").state,
      $: environment.$,
      composerPort: composer,
      suggestionsPort: suggestions,
      uploadsPort: uploads,
      queuePort: queue,
      submissionPort: submission,
      workspacePort: workspace,
    }),
  );
  install(
    workbench,
    assembleWorkbench({
      viewUpdates: environment.viewUpdates,
      t: environment.t,
      i18n: environment.i18n,
      workspacePreparation: environment.workspacePreparation,
      navigationPort: navigation,
      workspacePort: workspace,
      settingsPort: settings,
      projectsPort: projects,
      sidebarPort: sidebar,
      statusPort: status,
      approvalsPort: approvals,
      sidebarLayoutPort: sidebarLayout,
      panelsPort: panels,
      state: environment.stateFor("workbench").state,
      mutations: environment.stateFor("workbench").mutations,
    }),
  );
  install(
    sessionWorkspace,
    assembleSessionWorkspace({
      state: environment.stateFor("sessionWorkspace").state,
      identity: environment.identityKey,
      t: environment.t,
      i18n: environment.i18n,
      modelsPort: models,
      statusPort: status,
      approvalsPort: approvals,
      projectsPort: projects,
      workbenchPort: workbench,
      panelsPort: panels,
      detailsPort: details,
      timingPort: timing,
      noticesPort: notices,
      sidebarLayoutPort: sidebarLayout,
    }),
  );
  install(
    applicationProjections,
    assembleApplicationProjections({
      viewUpdates: environment.viewUpdates,
      renderBatch: environment.renderBatch,
      transportPort: transport,
      connectionPort: connection,
      workbenchPort: workbench,
      sidebarPort: sidebar,
      workspacePort: workspace,
      detailsPort: details,
      reviewPort: review,
      goalsPort: goals,
      statusPort: status,
      modelsPort: models,
      composerPort: composer,
      timelinePort: timeline,
      sideTasksPort: sideTasks,
      deliveryPort: delivery,
      approvalsPort: approvals,
      accountPort: account,
      messagesPort: messages,
      activityPort: activity,
      sessionWorkspacePort: sessionWorkspace,
    }),
  );
  const workbenchChrome = assembleWorkbenchChrome({
    t: environment.t,
    i18n: environment.i18n,
    workbenchPort: workbench,
    settingsPort: settings,
    sidebarLayoutPort: sidebarLayout,
    sessionWorkspacePort: sessionWorkspace,
    noticesPort: notices,
  });
  applicationProjections.bind();
  bindings.bind();
  localization.bind();
  queue.bind();
  details.bind();
  startup.bind();
  viewport.bind();
  navigation.bind();
  uploads.bind();
  settings.bind();
  account.bind();
  images.bind();
  clipboard.bind();
  panels.bind();
  sessionWorkspace.bind();
  diagnostics.bind();
  sidebarLayout.bind();
  workbenchChrome.bind();
  workspace.bind();
  sidebar.bind();
  composerInteractions.bind();
  startup.boot().catch((error) => {
    environment.workspacePreparation.fail("configuration");
    console.error("[panda-force] workspace preparation failed", error);
  });
}
