// Prepares one native input destination and preserves a committed session across metadata failures.
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
    onCreated = () => {},
  }) {
    if (!thread) {
      const projectless = state.projectless;
      await workspacePort.prepareBusinessSession(projectId);
      const result = await transportPort.rpc("thread/start", {
        cwd,
        model,
        ...policy,
        sessionStartSource: "startup",
        pandaProjectless: projectless,
      });
      thread = { ...result.thread, projectless };
      onCreated(thread);
      if (projectId) projectsPort.businessProjects.pendingAssignments.set(thread.id, projectId);
      pending.owner = thread.id;
      deliveryPort.lockIfFree(thread.id, token);
      sessions.addSummary(thread);
      if (generation === selection.current) {
        sessions.replaceActive(thread);
        navigationPort.rememberActiveThread(thread.id);
        viewUpdates.request("contextUsage");
        viewUpdates.request("header");
        viewUpdates.request("approvals");
      }
      viewUpdates.request("sidebar");
    } else if (thread.canAcceptDirectInput !== true) await resumeActiveThread(thread);
    await projectsPort.businessProjects.finishAssignment(thread);
    return thread;
  }
  return {
    prepareInputSession,
    resumeActiveThread,
  };
}
