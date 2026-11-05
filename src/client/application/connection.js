import { createBridgeError } from "../../shared/bridge-errors.js";

// Routes transport envelopes and connection transitions; native event interpretation is delegated.
export function assembleConnection({
  transportPort,
  viewUpdates,
  mutations,
  state,
  workspacePreparation,
  t,
  $,
  startupPort,
  synchronizationPort,
  sidebarPort,
  notificationsPort,
  approvalsPort,
  projectsPort,
  modelsPort,
  usagePort,
}) {
  function handle(message) {
    if (message.type === "project-catalog/changed") {
      projectsPort.businessProjects.apply(message);
      return;
    }
    if (message.type === "projects/visibility") {
      sidebarPort.applyProjectVisibility(message);
      return;
    }
    if (message.type === "bridge/status") {
      if (message.status === "connected") {
        workspacePreparation.complete("connection");
        const shouldLoad = !state.connected;
        mutations.set("connected", true);
        transportPort.resetReconnectBackoff();
        transportPort.clearTransportReconnectTimer();
        setStatus("connected", "Codex connected");
        if (shouldLoad) {
          startupPort.loadInitial();
          modelsPort.requestTaskNotifyPermission();
        } else {
          synchronizationPort.refreshThreadList();
          synchronizationPort.scheduleActiveThreadSync(0);
        }
      } else {
        startupPort.invalidateInitialLoad();
        if (message.status === "disconnected") {
          approvalsPort.clearApprovals({ removeCards: true });
        }
        mutations.set("connected", false);
        workspacePreparation.start("connection");
        usagePort.showUsageDisconnected();
        setStatus("connecting", "Connecting to Codex");
      }
      return;
    }
    if (message.type === "rpc/result" || message.type === "rpc/error" || message.type === "ack") {
      if (message.projectVisibility) sidebarPort.applyProjectVisibility(message.projectVisibility);
      const p = state.pending.get(message.id);
      if (!p) return;
      mutations.collection("pending").delete(message.id);
      message.type === "rpc/error"
        ? p.reject(createBridgeError(message.error, message.code))
        : p.resolve(message.result);
      return;
    }
    if (message.type === "codex/notification")
      notificationsPort.onNotification(message.payload.method, message.payload.params || {});
    if (message.type === "codex/request") approvalsPort.onServerRequest(message.payload);
  }
  function setStatus(kind, text) {
    viewUpdates.request("workbench");
    $("#statusDot").className = "status-dot" + (kind === "connected" ? " connected" : kind === "error" ? " error" : "");
    $("#statusText").textContent = t(text || kind);
  }
  function onDisrupted() {
    workspacePreparation.start("connection");
    startupPort.invalidateInitialLoad();
    synchronizationPort.scheduleThreadListRefresh(0);
    synchronizationPort.scheduleActiveThreadSync(0);
  }
  return { handle, setStatus, onDisrupted };
}
