const TARGETS = new Set([
  "composerPlaceholder",
  "workspaceContext",
  "accountMenu",
  "item",
  "workbench",
  "sidebar",
  "header",
  "details",
  "review",
  "goals",
  "status",
  "contextUsage",
  "composerSubmit",
  "composerLayout",
  "composerDraft",
  "conversation",
  "sideTasks",
  "pendingMessages",
  "approvals",
  "approvalMenu",
  "sessionOpened",
  "newTask",
  "sessionWorkspace",
]);

// This channel updates projections only. Native commands and approval decisions
// retain explicit interfaces and cannot be dispatched through this allowlist.
export function createProjectionUpdates() {
  let handlers = null;
  const active = new Set(),
    pending = new Map();
  function request(target, payload) {
    if (!TARGETS.has(target)) throw new Error(`Unknown projection: ${target}`);
    if (!handlers) {
      if (!["newTask", "sessionOpened"].includes(target)) pending.set(target, payload);
      return;
    }
    if (active.has(target)) return;
    active.add(target);
    try {
      handlers[target](payload);
    } finally {
      active.delete(target);
    }
  }
  return Object.freeze({
    request,
    attach(next) {
      if (handlers) throw new Error("Projection handlers already attached");
      for (const target of TARGETS)
        if (typeof next[target] !== "function") throw new Error(`Missing projection: ${target}`);
      handlers = Object.freeze(Object.fromEntries([...TARGETS].map((target) => [target, next[target]])));
      for (const [target, payload] of pending) request(target, payload);
      pending.clear();
    },
  });
}
