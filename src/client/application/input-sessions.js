// Prepares one native input destination and preserves a committed session across metadata failures.
/** @param {import("./ports.js").FeatureOptions<"selection" | "viewUpdates" | "sessions" | "state", "transport" | "navigation" | "workspace" | "projects" | "delivery", "inputSessions">} options */
export function assembleInputSessions({
  transportPort,
  selection,
  viewUpdates,
  sessions,
  state,
  navigationPort,
  workspacePort,
  projectsPort,
  deliveryPort,
}) {
  /** @param {import("../../shared/data-view.js").DataView<import("../../shared/engine/types.js").SessionSummary> | null} thread */
  async function resumeActiveThread(thread = state.active) {
    if (!thread) return null;
    const generation = selection.current;
    const resumed = await transportPort.rpc("thread/resume", {
      threadId: thread.id,
      excludeTurns: true,
      pandaPrepareInput: true,
    });
    if (generation === selection.current && state.active?.id === thread.id) {
      sessions.replaceActive({ ...state.active, ...resumed.thread });
      viewUpdates.request("header");
    }
    return resumed;
  }
  // Both immediate and queued input use the same creation/association boundary.
  async function prepareInputSession({
    thread,
    cwd,
    model,
    policy,
    projectId,
    generation,
    pending,
    token,
    resumeExisting = true,
    onCreated = (_created) => {},
  }) {
    if (!thread) {
      const projectless = projectId ? false : state.projectless;
      const workspace = await workspacePort.prepareBusinessSession(projectId);
      const result = await transportPort.rpc("thread/start", {
        cwd: workspace?.path || cwd,
        model,
        ...policy,
        ...(projectId ? { pandaProjectId: projectId } : {}),
        sessionStartSource: "startup",
        pandaProjectless: projectless,
      });
      thread = { ...result.thread, projectless };
      onCreated(thread);
      if (projectId && result.pandaProjectId === projectId && result.pandaProjectCatalog)
        projectsPort.businessProjects.apply(result.pandaProjectCatalog);
      else if (projectId) projectsPort.businessProjects.pendingAssignments.set(thread.id, projectId);
      pending.owner = thread.id;
      deliveryPort.lockIfFree(thread.id, token);
      sessions.addSummary(thread);
      if (generation === selection.current) {
        sessions.replaceActive(thread);
        navigationPort.rememberActiveThread(thread.id);
        viewUpdates.request("sessionOpened", thread.id);
        viewUpdates.request("contextUsage");
        viewUpdates.request("header");
        viewUpdates.request("approvals");
      }
      viewUpdates.request("sidebar");
    } else if (resumeExisting && thread.canAcceptDirectInput !== true) await resumeActiveThread(thread);
    await projectsPort.businessProjects.finishAssignment(thread);
    return { ...thread, turns: thread.turns || [] };
  }
  return {
    prepareInputSession,
    resumeActiveThread,
  };
}
