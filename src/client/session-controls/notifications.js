import { storage, STORAGE_KEYS } from "../storage.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";

/** Notification permission is requested only from the user toggle gesture. */
export function createTaskCompletionNotifications({ $, t, threads, toast }) {
  let requestingNotificationPermission = false;
  function taskNotifyEnabled() {
    return storage.get(STORAGE_KEYS.taskNotify) !== "false";
  }
  function syncTaskNotifySettings() {
    const toggle = $("#settingsTaskNotifyToggle");
    if (toggle) {
      const available = "Notification" in window;
      toggle.checked =
        available &&
        (requestingNotificationPermission || (taskNotifyEnabled() && Notification.permission === "granted"));
      toggle.disabled = !available || requestingNotificationPermission;
      toggle.setAttribute("aria-busy", String(requestingNotificationPermission));
    }
  }
  async function setTaskNotifyEnabled(enabled) {
    if (requestingNotificationPermission) return;
    const on = Boolean(enabled);
    if (!on || !("Notification" in window)) {
      storage.set(STORAGE_KEYS.taskNotify, "false");
      syncTaskNotifySettings();
      return;
    }
    try {
      requestingNotificationPermission = Notification.permission === "default";
      syncTaskNotifySettings();
      // This path is called only by the user's notification toggle gesture.
      const permission = requestingNotificationPermission
        ? await Notification.requestPermission()
        : Notification.permission;
      storage.set(STORAGE_KEYS.taskNotify, String(permission === "granted"));
      if (permission === "denied") toast(t("sessions.browserNotificationsAreBlocked"));
    } catch {
      storage.set(STORAGE_KEYS.taskNotify, "false");
      toast(t("errors.couldNotEnableBrowserNotifications"));
    } finally {
      requestingNotificationPermission = false;
      syncTaskNotifySettings();
    }
  }
  function maybeNotifyTaskCompleted(p) {
    if (!taskNotifyEnabled()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.hasFocus() && !document.hidden) return;
    const thread = threads().find((x) => x.id === p.threadId),
      title = thread?.name || t("sessions.taskCompleted");
    try {
      new Notification(t("sessions.taskCompleted"), { body: title, tag: `codex-turn-${p.turn?.id || Date.now()}` });
    } catch (error) {
      reportDiagnostic("session-notification.create", error);
    }
  }
  return { syncTaskNotifySettings, setTaskNotifyEnabled, maybeNotifyTaskCompleted };
}
