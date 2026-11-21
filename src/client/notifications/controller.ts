import type { CreationNotification } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { creationApiFor, CreationApiError } from "../creation/api.js";
import { creationDocumentRoute } from "../creation/delivery-route.js";
import { LazyCreativeAssetsPanel } from "../creative/assets-lazy.js";
import { codexIcon } from "../codex-icons.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "../i18n.js";
import { requireElement } from "../dom.js";

type Entry = CreationNotification & { scope: "application" | "personal" };
const activeIdentity = () =>
  (globalThis as typeof globalThis & { __pandaForceIdentityKey?: string }).__pandaForceIdentityKey;
/** A durable owner-scoped inbox is independent of the active page and of native engine sessions. */
export class CreationCompletionNotifications {
  private readonly button = document.createElement("button");
  private readonly badge = document.createElement("span");
  private readonly dialog = document.createElement("dialog");
  private readonly heading = document.createElement("h2");
  private readonly close = document.createElement("button");
  private readonly list = document.createElement("ol");
  private readonly notice = document.createElement("p");
  private readonly retry = document.createElement("button");
  private readonly apis = { application: creationApiFor(), personal: creationApiFor("personal") };
  private readonly viewer: LazyCreativeAssetsPanel;
  private readonly abort = new AbortController();
  private entries: Entry[] = [];
  private pending?: Promise<void>;
  private reading?: AbortController;
  private navigating = false;
  private failed = false;
  private signature = "";
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly update = () => void this.refresh();
  private readonly leaving = () => {
    this.navigating = true;
    this.reading?.abort();
  };
  private readonly returned = () => {
    this.navigating = false;
    this.update();
  };
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
    private readonly navigate: (path: string) => void,
  ) {
    this.viewer = new LazyCreativeAssetsPanel(t, "notificationDeliveryViewer", identity);
    this.button.type = "button";
    this.button.id = "creationNotificationsButton";
    this.button.className = "icon-button creation-notifications-button";
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-controls", "creationNotificationsDialog");
    setMessageHtml(this.button, codexIcon("bell"));
    this.badge.className = "creation-notifications-badge";
    this.badge.setAttribute("aria-hidden", "true");
    this.badge.hidden = true;
    this.button.append(this.badge);
    requireElement(".top-actions").prepend(this.button);
    this.dialog.id = "creationNotificationsDialog";
    this.dialog.className = "workbench-dialog creation-notifications-dialog";
    this.dialog.setAttribute("aria-labelledby", "creationNotificationsHeading");
    this.heading.id = "creationNotificationsHeading";
    const header = document.createElement("header");
    this.close.type = "button";
    this.close.className = "icon-button";
    setMessageHtml(this.close, codexIcon("x"));
    this.close.onclick = () => this.dialog.close();
    header.append(this.heading, this.close);
    this.list.className = "creation-notifications-list";
    this.notice.setAttribute("role", "status");
    this.retry.type = "button";
    this.retry.className = "wb-button";
    this.retry.onclick = this.update;
    this.dialog.append(header, this.notice, this.list, this.retry);
    this.dialog.addEventListener("close", () => this.button.focus());
    document.body.append(this.dialog);
    this.button.onclick = () => {
      this.render();
      this.dialog.showModal();
      void this.refresh();
    };
    window.addEventListener("focus", this.update);
    window.addEventListener("pagehide", this.leaving);
    window.addEventListener("beforeunload", this.leaving);
    window.addEventListener("pageshow", this.returned);
    window.addEventListener("panda-force:creation-completed", this.update);
    document.addEventListener("visibilitychange", this.update);
    this.timer = setInterval(this.update, 15000);
    this.render();
    void this.refresh();
  }
  refresh() {
    if (this.abort.signal.aborted || this.navigating || document.hidden) return Promise.resolve();
    if (activeIdentity() && activeIdentity() !== this.identity) {
      this.dispose();
      return Promise.resolve();
    }
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.reading = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, this.reading.signal]);
      const scopes = ["application", "personal"] as const;
      const results = await Promise.allSettled(scopes.map((scope) => this.apis[scope].notifications(signal)));
      if (signal.aborted) return;
      if (activeIdentity() && activeIdentity() !== this.identity) {
        this.dispose();
        return;
      }
      this.failed = false;
      for (const [index, result] of results.entries()) {
        const scope = scopes[index]!;
        if (result.status === "fulfilled")
          this.entries = [
            ...this.entries.filter((entry) => entry.scope !== scope),
            ...result.value.items.map((entry) => ({ ...entry, scope })),
          ];
        else {
          this.failed = true;
          if (result.reason instanceof CreationApiError && [401, 403].includes(result.reason.status))
            this.entries = this.entries.filter((entry) => entry.scope !== scope);
        }
      }
      this.entries.sort(
        (a, b) =>
          Number(a.readAt !== null) - Number(b.readAt !== null) ||
          b.createdAt - a.createdAt ||
          a.taskId.localeCompare(b.taskId),
      );
      this.render();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  render() {
    if (this.abort.signal.aborted) return;
    const unread = this.entries.filter((entry) => entry.readAt === null).length;
    localizeAttribute(this.button, "aria-label", "creation.notificationsUnread", { count: unread }, this.t);
    localizeAttribute(this.button, "title", "creation.notificationsTitle", undefined, this.t);
    setOpaqueText(this.badge, unread > 99 ? "99+" : String(unread));
    this.badge.hidden = !unread;
    localizeText(this.heading, "creation.notificationsTitle", undefined, this.t);
    localizeAttribute(this.close, "aria-label", "common.close", undefined, this.t);
    localizeText(this.retry, "common.retry", undefined, this.t);
    this.retry.hidden = !this.failed;
    this.notice.textContent = this.failed
      ? this.t("creation.notificationsLoadFailed")
      : this.entries.length
        ? ""
        : this.t("creation.notificationsEmpty");
    const signature = JSON.stringify([this.entries, document.documentElement.lang]);
    if (signature === this.signature) return;
    this.signature = signature;
    const focused = (document.activeElement as HTMLElement)?.dataset.notificationKey,
      scroll = this.dialog.scrollTop;
    this.list.replaceChildren(
      ...this.entries.map((entry) => {
        const li = document.createElement("li"),
          button = document.createElement("button"),
          title = document.createElement("strong"),
          status = document.createElement("span"),
          time = document.createElement("time");
        button.type = "button";
        button.className = "creation-notification";
        button.dataset.notificationKey = entry.scope + ":" + entry.taskId + ":" + entry.generation;
        button.dataset.unread = String(entry.readAt === null);
        setOpaqueText(title, entry.title || this.t("creation.notificationsReady"));
        localizeText(status, "creation.notificationsOpen", undefined, this.t);
        time.dateTime = new Date(entry.createdAt).toISOString();
        time.textContent = new Intl.DateTimeFormat(document.documentElement.lang, {
          dateStyle: "short",
          timeStyle: "short",
        }).format(entry.createdAt);
        button.append(title, status, time);
        button.onclick = () => this.open(entry);
        li.append(button);
        return li;
      }),
    );
    this.dialog.scrollTop = scroll;
    if (focused)
      this.list
        .querySelector<HTMLButtonElement>(`[data-notification-key="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
  }
  private open(entry: Entry) {
    if (this.abort.signal.aborted) return;
    entry.readAt ??= Date.now();
    this.render();
    void this.apis[entry.scope]
      .readNotification(entry.taskId, entry.generation, this.abort.signal)
      .then(() => this.refresh())
      .catch(() => {
        if (this.abort.signal.aborted) return;
        this.failed = true;
        this.render();
      });
    this.dialog.close();
    if (entry.artifact.kind === "document") this.navigate(creationDocumentRoute(entry.artifact));
    else
      void this.viewer
        .follow(entry.artifact.projectId, entry.artifact.assetId, async () => {}, entry.artifact.version)
        .catch(() => {
          if (!this.abort.signal.aborted) {
            this.notice.textContent = this.t("documents.unavailable");
            this.dialog.showModal();
          }
        });
  }
  dispose() {
    this.abort.abort();
    clearInterval(this.timer);
    window.removeEventListener("focus", this.update);
    window.removeEventListener("pagehide", this.leaving);
    window.removeEventListener("beforeunload", this.leaving);
    window.removeEventListener("pageshow", this.returned);
    window.removeEventListener("panda-force:creation-completed", this.update);
    document.removeEventListener("visibilitychange", this.update);
    this.button.remove();
    this.dialog.remove();
    this.viewer.close();
    this.entries = [];
  }
}
