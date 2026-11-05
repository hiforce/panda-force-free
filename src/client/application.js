// Composition root. Read/write grants are supplied per feature, never shared as a writable global.
import { assembleEnvironment } from "./application/environment.js";
import { assembleLocalization } from "./application/localization.js";
import { assembleHistory } from "./application/history.js";
import { assembleQueue } from "./application/queue.js";
import { assembleStatus, assembleGoals, assembleApprovals, assembleModels } from "./application/engine-services.js";
import { assembleComposer } from "./application/composer.js";
import { assembleDetails } from "./application/details.js";
import { assembleTiming } from "./application/timing.js";
import { assembleStartup } from "./application/startup.js";
import { assembleViewport } from "./application/viewport.js";
import { assembleNotices } from "./application/notices.js";
import { assembleNavigation } from "./application/navigation.js";
import { assembleCommands } from "./application/commands.js";
import { assembleSideTasks } from "./application/side-tasks.js";
import { assembleTurnFrames } from "./application/turn-frames.js";
import { assembleConnection } from "./application/connection.js";
import { assembleTimeline } from "./application/timeline.js";
import { assembleTransport } from "./application/transport-service.js";
import {
  assembleReview,
  assembleActivity,
  assembleUploads,
  assembleUsage,
  assembleSettings,
  assembleAccount,
} from "./application/interface-services.js";
import { assembleImages } from "./application/images.js";
import { assembleClipboard } from "./application/clipboard.js";
import { assemblePanels } from "./application/panels.js";
import { assembleBindings } from "./application/bindings.js";
import { assembleDiagnostics } from "./application/diagnostics.js";
import { assembleNotifications } from "./application/notifications.js";
import { assembleSuggestions } from "./application/suggestions.js";
import { assembleSubmission } from "./application/submission.js";
import { assembleMessages } from "./application/messages.js";
import { assembleDelivery } from "./application/delivery.js";
import { assembleSidebarLayout } from "./application/sidebar-layout.js";
import { assembleSynchronization } from "./application/synchronization.js";
import { assembleWorkspace } from "./application/workspace.js";
import { assembleRepositories } from "./application/repositories.js";
import { assembleInputSessions } from "./application/input-sessions.js";
import { assembleIdentity } from "./application/identity.js";
import { assembleProjects, assembleSidebar, assembleWorkbench } from "./application/workspace-services.js";
import { assembleComposerInteractions } from "./application/composer-interactions.js";
import { assembleApplicationProjections } from "./application/application-projections.js";

export function startApplication() {
  const environment = {};
  const localization = {};
  const history = {};
  const queue = {};
  const status = {};
  const goals = {};
  const approvals = {};
  const models = {};
  const composer = {};
  const details = {};
  const timing = {};
  const startup = {};
  const viewport = {};
  const notices = {};
  const navigation = {};
  const commands = {};
  const sideTasks = {};
  const turnFrames = {};
  const connection = {};
  const timeline = {};
  const transport = {};
  const review = {};
  const activity = {};
  const uploads = {};
  const usage = {};
  const settings = {};
  const account = {};
  const images = {};
  const clipboard = {};
  const panels = {};
  const bindings = {};
  const diagnostics = {};
  const notifications = {};
  const suggestions = {};
  const submission = {};
  const messages = {};
  const delivery = {};
  const sidebarLayout = {};
  const synchronization = {};
  const workspace = {};
  const repositories = {};
  const inputSessions = {};
  const identity = {};
  const projects = {};
  const sidebar = {};
  const composerInteractions = {};
  const workbench = {};
  const applicationProjections = {};
  const install = (port, implementation) =>
    Object.defineProperties(port, Object.getOwnPropertyDescriptors(implementation));
  install(environment, assembleEnvironment({}));
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
      legacyState: environment.stateFor("status").legacyState,
      $: environment.$,
      t: environment.t,
      i18n: environment.i18n,
      titleOf: environment.titleOf,
      shortPath: environment.shortPath,
      escapeHtml: environment.escapeHtml,
    }),
  );
  install(
    goals,
    assembleGoals({
      viewUpdates: environment.viewUpdates,
      transportPort: transport,
      legacyState: environment.stateFor("goals").legacyState,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      timingPort: timing,
      noticesPort: notices,
    }),
  );
  install(
    approvals,
    assembleApprovals({
      transportPort: transport,
      turnFramesPort: turnFrames,
      viewUpdates: environment.viewUpdates,
      legacyState: environment.stateFor("approvals").legacyState,
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
    }),
  );
  install(
    models,
    assembleModels({
      transportPort: transport,
      legacyState: environment.stateFor("models").legacyState,
      $: environment.$,
      t: environment.t,
      escapeHtml: environment.escapeHtml,
      workspacePreparation: environment.workspacePreparation,
      noticesPort: notices,
    }),
  );
  install(
    composer,
    assembleComposer({
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
    assembleTransport({ legacyState: environment.stateFor("transport").legacyState, t: environment.t }),
  );
  install(
    review,
    assembleReview({
      renderBatch: environment.renderBatch,
      legacyState: environment.stateFor("review").legacyState,
      $: environment.$,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      noticesPort: notices,
      panelsPort: panels,
    }),
  );
  install(
    activity,
    assembleActivity({
      turnFramesPort: turnFrames,
      renderBatch: environment.renderBatch,
      legacyState: environment.stateFor("activity").legacyState,
      escapeHtml: environment.escapeHtml,
      shortPath: environment.shortPath,
      identityPort: identity,
      timingPort: timing,
    }),
  );
  install(
    uploads,
    assembleUploads({
      viewUpdates: environment.viewUpdates,
      legacyState: environment.stateFor("uploads").legacyState,
      $: environment.$,
      t: environment.t,
      imagesPort: images,
      noticesPort: notices,
    }),
  );
  install(
    usage,
    assembleUsage({
      transportPort: transport,
      legacyState: environment.stateFor("usage").legacyState,
      $: environment.$,
      t: environment.t,
      i18n: environment.i18n,
    }),
  );
  install(
    settings,
    assembleSettings({
      legacyState: environment.stateFor("settings").legacyState,
      $: environment.$,
      t: environment.t,
      shortPath: environment.shortPath,
      modelsPort: models,
      panelsPort: panels,
      viewUpdates: environment.viewUpdates,
    }),
  );
  install(
    account,
    assembleAccount({
      legacyState: environment.stateFor("account").legacyState,
      $: environment.$,
      t: environment.t,
      state: environment.stateFor("account").state,
      settingsPort: settings,
      modelsPort: models,
      panelsPort: panels,
      usagePort: usage,
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
    assembleRepositories({ mutations: environment.stateFor("repositories").mutations, sessions: environment.sessions }),
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
      legacyState: environment.stateFor("projects").legacyState,
    }),
  );
  install(
    sidebar,
    assembleSidebar({
      transportPort: transport,
      viewUpdates: environment.viewUpdates,
      mutations: environment.stateFor("sidebar").mutations,
      legacyState: environment.stateFor("sidebar").legacyState,
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
      legacyState: environment.stateFor("workbench").legacyState,
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
    }),
  );
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
  diagnostics.bind();
  sidebarLayout.bind();
  workspace.bind();
  sidebar.bind();
  composerInteractions.bind();
  for (const port of [
    environment,
    localization,
    history,
    queue,
    status,
    goals,
    approvals,
    models,
    composer,
    details,
    timing,
    startup,
    viewport,
    notices,
    navigation,
    commands,
    sideTasks,
    turnFrames,
    connection,
    timeline,
    transport,
    review,
    activity,
    uploads,
    usage,
    settings,
    account,
    images,
    clipboard,
    panels,
    bindings,
    diagnostics,
    notifications,
    suggestions,
    submission,
    messages,
    delivery,
    sidebarLayout,
    synchronization,
    workspace,
    repositories,
    inputSessions,
    identity,
    projects,
    sidebar,
    composerInteractions,
    workbench,
    applicationProjections,
  ])
    Object.freeze(port);
  startup.boot().catch((error) => {
    environment.workspacePreparation.fail("configuration");
    console.error("[panda-force] workspace preparation failed", error);
  });
}
