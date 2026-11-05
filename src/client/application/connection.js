import { localizeText } from "../i18n.js";

import { createBridgeError } from "../../shared/bridge-errors.js";

// Routes transport envelopes and connection transitions; native event interpretation is delegated.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "state" | "workspacePreparation" | "t" | "$", "transport" | "startup" | "synchronization" | "sidebar" | "notifications" | "approvals" | "projects" | "models" | "usage" | "history", "connection">} options */
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
  historyPort,
}) {
  function handle(message) {
    if (message.type === "bridge/resync") {
      approvalsPort.clearApprovals({ removeCards: true });
      void approvalsPort.refreshPendingApprovals();
      void historyPort.resyncActiveConversation();
      return;
    }
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
        setStatus("connected", "common.codexConnected");
        if (shouldLoad) {
          startupPort.loadInitial();
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
        setStatus("connecting", "common.connectingToCodex");
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
    if (["engine/notification", "codex/notification"].includes(message.type))
      notificationsPort.onNotification(message.payload.method, message.payload.params || {});
    if (["engine/request", "codex/request"].includes(message.type)) approvalsPort.onServerRequest(message.payload);
  }
  function setStatus(kind, text) {
    viewUpdates.request("workbench");
    $("#statusDot").className = "status-dot" + (kind === "connected" ? " connected" : kind === "error" ? " error" : "");
    localizeText($("#statusText"), text || kind, undefined, t);
  }
  function onDisrupted() {
    workspacePreparation.start("connection");
    startupPort.invalidateInitialLoad();
    synchronizationPort.scheduleThreadListRefresh(0);
    synchronizationPort.scheduleActiveThreadSync(0);
  }
  return { handle, setStatus, onDisrupted };
}
