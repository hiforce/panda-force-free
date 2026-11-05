import { isRecord } from "../../shared/records.js";
import { notifyNtfyTurnCompleted } from "../misc/ntfy.js";
import { publishCatalogUpdate } from "../projects/publish.js";
import type { EngineEnvelope, EngineEventParameters } from "../../shared/engine/contracts.js";
type NativeItem = NonNullable<EngineEventParameters["item"]>;
import type { RuntimeServices } from "./../services.js";
import { createNotificationRegistry } from "./notifications.js";

/** Registers native event side effects; transport and storage retain their own lifetimes. */
export function createEngineNotifications({
  presentBrowserData,
  projectCatalog,
  pendingEngineRequests,
  autoContinueRecovery,
  reviewDiffs,
  recoverMessageQueue,
  threadHub,
  accountLoader,
  request,
  broadcast,
}: Pick<
  RuntimeServices,
  | "presentBrowserData"
  | "projectCatalog"
  | "pendingEngineRequests"
  | "autoContinueRecovery"
  | "reviewDiffs"
  | "recoverMessageQueue"
  | "threadHub"
  | "accountLoader"
  | "request"
  | "broadcast"
>) {
  function userMessageText(item: NativeItem | undefined): string {
    if (item?.type !== "userMessage" || !Array.isArray(item.content)) return "";
    return item.content
      .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }

  function scheduleGoalCommand(threadId: unknown, item: NativeItem | undefined) {
    if (typeof threadId !== "string" || !threadId) return;
    const text = userMessageText(item).toLowerCase();
    if (text === "/goal resume") {
      void request("thread/goal/set", { threadId, status: "active", origin: "user" }).catch((error) =>
        console.error("[panda-force] goal resume sync failed:", error instanceof Error ? error.message : error),
      );
    } else if (text === "/goal pause") {
      void request("thread/goal/set", { threadId, status: "paused", origin: "user" }).catch((error) =>
        console.error("[panda-force] goal pause sync failed:", error instanceof Error ? error.message : error),
      );
    } else if (text === "/goal clear") {
      void request("thread/goal/clear", { threadId, origin: "user" }).catch((error) =>
        console.error("[panda-force] goal clear sync failed:", error instanceof Error ? error.message : error),
      );
    }
  }

  const notifications = createNotificationRegistry();
  notifications.onAny((message) => autoContinueRecovery.onNotification(message));
  notifications.onAny((message) => {
    if (typeof message.params?.threadId === "string") threadHub.invalidateHistory(message.params.threadId);
  });
  notifications.on(["item/started", "item/completed"], (params) => scheduleGoalCommand(params.threadId, params.item));
  notifications.on(["thread/closed", "thread/deleted"], (params) => {
    if (params.threadId) threadHub.dropSubscription(params.threadId);
  });
  notifications.on("thread/status/changed", (params) => {
    if (params.threadId) threadHub.recordThreadStatus(params.threadId, params.status);
  });
  notifications.on("serverRequest/resolved", (params) => {
    if (params.requestId !== undefined) pendingEngineRequests.delete(params.requestId);
  });
  notifications.on("account/updated", () => accountLoader.invalidate());
  notifications.on("thread/name/updated", (params) => {
    const threadId = params.threadId;
    if (!threadId) return;
    publishCatalogUpdate(projectCatalog, broadcast, () => {
      const snapshot = projectCatalog.refreshSessions([{ id: threadId, name: params.threadName || params.name }]);
      return snapshot;
    });
  });
  notifications.on("turn/diff/updated", (params) =>
    reviewDiffs.record({ threadId: params.threadId, turnId: params.turnId, diff: params.diff }),
  );
  notifications.on("item/fileChange/patchUpdated", (params) => threadHub.recordFileChangeDiff(params));
  notifications.on("item/completed", (params) => {
    if (params.item?.type === "fileChange") threadHub.recordFileChangeDiff({ ...params, changes: params.item.changes });
  });
  notifications.on("turn/completed", (params) => {
    void notifyNtfyTurnCompleted(params);
    void recoverMessageQueue(params.threadId);
  });

  function handleEngineMessage(input: EngineEnvelope) {
    const message = presentBrowserData(input);
    if (message.id !== undefined && message.method) {
      pendingEngineRequests.set(message.id, message);
      broadcast({ type: "engine/request", payload: message });
      return;
    }
    if (message.method) {
      notifications.dispatch(message);
      // Keep the server receive time explicit and timezone-safe for browser clients.
      // Native app-server timestamps are Unix seconds; this ISO value is only the
      // fallback for events that do not carry a lifecycle timestamp of their own.
      const payload = { ...message, params: { ...(message.params || {}), pandaReceivedAt: new Date().toISOString() } };
      broadcast({ type: "engine/notification", payload });
    }
  }

  return handleEngineMessage;
}
