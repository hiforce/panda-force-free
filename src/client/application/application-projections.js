// This parent connects read-model projections. Feature modules never resolve
// arbitrary commands through the update channel.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "renderBatch", "transport" | "connection" | "workbench" | "sidebar" | "workspace" | "details" | "review" | "goals" | "status" | "models" | "composer" | "timeline" | "sideTasks" | "delivery" | "approvals" | "account" | "messages" | "activity", "applicationProjections">} options */
export function assembleApplicationProjections({
  viewUpdates,
  renderBatch,
  transportPort,
  connectionPort,
  workbenchPort,
  sidebarPort,
  workspacePort,
  detailsPort,
  reviewPort,
  goalsPort,
  statusPort,
  modelsPort,
  composerPort,
  timelinePort,
  sideTasksPort,
  deliveryPort,
  approvalsPort,
  accountPort,
  messagesPort,
  activityPort,
}) {
  function bind() {
    transportPort.attach({
      envelope: connectionPort.handle,
      status: connectionPort.setStatus,
      disrupted: connectionPort.onDisrupted,
    });
    renderBatch.subscribe((turnId) => {
      activityPort.activityRenderer.flush();
      reviewPort.reviewController.flush(turnId);
      sideTasksPort.flush();
    });
    viewUpdates.attach({
      workbench: () => workbenchPort.workbench?.refresh(),
      sidebar: () => sidebarPort.renderThreads(),
      header: () => workspacePort.renderHeader(),
      details: () => detailsPort.syncSummaryPanel(),
      review: () => reviewPort.renderChanges(),
      goals: (id) => goalsPort.syncGoalStatusSurface(id),
      status: () => statusPort.syncSessionStatusSurface(),
      contextUsage: () => modelsPort.renderContextUsage(),
      composerSubmit: () => composerPort.syncComposerSubmitState(),
      composerLayout: () => composerPort.resizePrompt(),
      composerDraft: () => composerPort.persistComposerDraft(),
      conversation: ({ thread, loadMore }) => timelinePort.renderThread(thread, loadMore),
      sideTasks: () => sideTasksPort.renderSideTasks(),
      pendingMessages: () => deliveryPort.renderPendingUserMessages(),
      approvals: () => approvalsPort.restorePendingApprovals(),
      approvalMenu: () => approvalsPort.approvalMenuController.close(),
      sessionOpened: (id) => workbenchPort.workbench?.threadOpened(id),
      newTask: () => workbenchPort.workbench?.taskStarted(),
      composerPlaceholder: () => workspacePort.refreshComposerPlaceholder(),
      workspaceContext: () => workspacePort.syncProjectControl(),
      accountMenu: (force) => accountPort.toggleAccountMenu(force),
      item: ({ item, turnId, root, live }) => messagesPort.upsertItem(item, turnId, root, live),
    });
  }
  return { bind };
}
