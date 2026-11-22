import { notificationKey, type NotificationItem, type NotificationPage } from "../../shared/notifications/contracts.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { notificationApi } from "./api.js";
import { NotificationCenterView, type NotificationMode } from "./view.js";

export interface NotificationIntentHandler {
  label: MessageId;
  directFromPreview?: boolean;
  run(data: unknown): Promise<void>;
}

const activeIdentity = () =>
  (globalThis as typeof globalThis & { __pandaForceIdentityKey?: string }).__pandaForceIdentityKey;

export class NotificationCenter {
  private readonly view: NotificationCenterView;
  private readonly abort = new AbortController();
  private readonly reads = new Map<string, number>();
  private unread = 0;
  private preview: NotificationItem[] = [];
  private pages: NotificationPage[] = [];
  private mode: NotificationMode = "preview";
  private detail?: NotificationItem;
  private pageIndex = 0;
  private detailOrigin: "preview" | "history" = "history";
  private listScroll = 0;
  private pending?: Promise<void>;
  private reading?: AbortController;
  private historyRead?: AbortController;
  private historyRetry?: { cursor: string | null };
  private navigating = false;
  private previewReady = false;
  private previewFailed = false;
  private actionFailed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly update = () => void this.refresh();
  private readonly leaving = () => {
    this.navigating = true;
    this.reading?.abort();
    this.stopHistoryRead();
  };
  private readonly returned = () => {
    this.navigating = false;
    this.update();
  };

  constructor(
    t: Translate,
    private readonly identity: string,
    private readonly actions: {
      intents: Record<string, NotificationIntentHandler>;
      close(): void;
    },
  ) {
    this.view = new NotificationCenterView(t, {
      preview: () => this.openPreview(),
      all: () => this.openHistory(),
      back: () => this.back(),
      page: (delta) => this.selectPage(delta),
      entry: (entry) => this.open(entry),
      deliver: () => {
        if (this.detail) this.runIntent(this.detail);
      },
      retry: () => this.retry(),
    });
    window.addEventListener("focus", this.update);
    window.addEventListener("pagehide", this.leaving);
    window.addEventListener("beforeunload", this.leaving);
    window.addEventListener("pageshow", this.returned);
    window.addEventListener("panda-force:notifications-changed", this.update);
    document.addEventListener("visibilitychange", this.update);
    this.timer = setInterval(this.update, 15000);
    this.render();
    this.update();
  }

  private authorized() {
    if (this.abort.signal.aborted) return false;
    const active = activeIdentity();
    if (active && active !== this.identity) {
      this.dispose();
      return false;
    }
    return true;
  }
  private refresh() {
    if (!this.authorized() || this.navigating || document.hidden) return;
    if (this.pending) return this.pending;
    this.reading = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, this.reading.signal]);
    this.pending = notificationApi
      .preview(signal)
      .then(({ items, unreadCount, partial }) => {
        if (signal.aborted || !this.authorized()) return;
        const reading = items.filter((item) => item.readAt === null && this.reads.has(notificationKey(item))).length;
        this.unread = Math.max(0, unreadCount - reading);
        this.preview = items.map((item) => this.applyRead(item));
        this.previewFailed = Boolean(partial);
      })
      .catch(() => {
        if (!signal.aborted && this.authorized()) this.previewFailed = true;
      })
      .finally(() => {
        this.pending = undefined;
        if (!signal.aborted) {
          this.previewReady = true;
          this.render();
        }
      });
    return this.pending;
  }

  private intent(entry?: NotificationItem) {
    const action = entry?.action;
    return action?.type === "intent" && Object.hasOwn(this.actions.intents, action.name)
      ? this.actions.intents[action.name]
      : undefined;
  }
  render() {
    if (this.abort.signal.aborted) return;
    const page = this.pages[this.pageIndex];
    this.view.render({
      mode: this.mode,
      entries: this.mode === "preview" ? this.preview : (page?.items ?? []),
      detail: this.mode === "detail" ? this.detail : undefined,
      intentLabel: this.intent(this.detail)?.label,
      direct: (entry) => Boolean(this.intent(entry)?.directFromPreview),
      unread: this.unread,
      page: this.pageIndex + 1,
      hasNext: Boolean(page?.nextCursor),
      loading: this.mode === "preview" ? !this.previewReady : this.mode === "history" && Boolean(this.historyRead),
      error: this.actionFailed
        ? "notifications.actionFailed"
        : (this.mode === "preview" ? this.previewFailed : this.historyRetry)
          ? "notifications.loadFailed"
          : undefined,
    });
  }

  private openPreview() {
    if (!this.authorized()) return;
    this.stopHistoryRead();
    this.mode = "preview";
    this.detail = undefined;
    this.actionFailed = false;
    this.render();
    this.view.show();
    this.update();
  }
  private openHistory() {
    this.mode = "history";
    this.pages = [];
    this.detail = undefined;
    this.pageIndex = 0;
    this.historyRetry = undefined;
    this.actionFailed = false;
    void this.loadPage(null);
    this.view.focus();
  }
  private stopHistoryRead() {
    this.historyRead?.abort();
    this.historyRead = undefined;
  }
  private back() {
    if (this.mode === "detail") {
      const key = this.detail && notificationKey(this.detail);
      this.mode = this.detailOrigin;
      this.detail = undefined;
      this.actionFailed = false;
      this.render();
      this.view.list.scrollTop = this.listScroll;
      this.view.focus(key);
    } else {
      this.openPreview();
      this.view.focus();
    }
  }
  private selectPage(delta: -1 | 1) {
    if (this.historyRead) return;
    const target = this.pageIndex + delta;
    if (this.pages[target]) {
      this.pageIndex = target;
      this.historyRetry = undefined;
      this.render();
      this.view.list.scrollTop = 0;
      this.view.focus();
    } else if (delta === 1) {
      const cursor = this.pages[this.pageIndex]?.nextCursor;
      if (cursor) void this.loadPage(cursor);
    }
  }
  private async loadPage(cursor: string | null) {
    if (this.historyRead || !this.authorized()) return;
    const request = new AbortController();
    this.historyRead = request;
    this.historyRetry = undefined;
    this.render();
    try {
      const page = await notificationApi.history(cursor, request.signal);
      if (request.signal.aborted || !this.authorized()) return;
      page.items = page.items.map((entry) => this.applyRead(entry));
      if (!page.items.length && this.pages.length) this.pages[this.pageIndex]!.nextCursor = null;
      else this.pageIndex = this.pages.push(page) - 1;
      this.view.list.scrollTop = 0;
      this.view.focus();
    } catch {
      if (!request.signal.aborted && this.authorized()) this.historyRetry = { cursor };
    } finally {
      if (this.historyRead === request) {
        this.historyRead = undefined;
        this.render();
      }
    }
  }

  private retry() {
    if (this.actionFailed && this.detail) this.runIntent(this.detail);
    else if (this.mode === "preview") this.update();
    else if (this.historyRetry) void this.loadPage(this.historyRetry.cursor);
  }
  private applyRead(entry: NotificationItem) {
    const mark = this.reads.get(notificationKey(entry));
    return mark && entry.readAt === null ? { ...entry, readAt: mark } : entry;
  }
  private markRead(entry: NotificationItem) {
    if (entry.readAt !== null) return;
    const key = notificationKey(entry);
    if (this.reads.has(key)) return;
    const stamp = Date.now();
    this.reads.set(key, stamp);
    const copies = () =>
      [this.preview, ...this.pages.map((page) => page.items), [entry]]
        .flat()
        .filter((item) => notificationKey(item) === key);
    for (const item of copies()) item.readAt ??= stamp;
    this.unread = Math.max(0, this.unread - 1);
    void notificationApi
      .read(entry, this.abort.signal)
      .catch(() => {
        if (this.abort.signal.aborted) return;
        for (const item of copies()) if (item.readAt === stamp) item.readAt = null;
      })
      .finally(async () => {
        this.reads.delete(key);
        await this.pending;
        this.update();
      });
  }
  private open(entry: NotificationItem) {
    if (!this.authorized()) return;
    this.stopHistoryRead();
    this.markRead(entry);
    this.detailOrigin = this.mode === "preview" ? "preview" : "history";
    this.listScroll = this.view.list.scrollTop;
    if (this.mode === "preview" && this.intent(entry)?.directFromPreview) {
      this.runIntent(entry);
      return;
    }
    this.mode = "detail";
    this.detail = entry;
    this.actionFailed = false;
    this.render();
    this.view.focus();
  }
  private runIntent(entry: NotificationItem) {
    if (!this.authorized() || entry.action?.type !== "intent") return;
    const intent = this.intent(entry);
    if (!intent) return;
    this.actionFailed = false;
    this.render();
    this.view.closeDialog();
    void intent.run(entry.action.data).catch(() => {
      if (!this.authorized()) return;
      this.mode = "detail";
      this.detail = entry;
      this.actionFailed = true;
      this.render();
      this.view.show();
    });
  }
  private dispose() {
    this.abort.abort();
    this.stopHistoryRead();
    clearInterval(this.timer);
    window.removeEventListener("focus", this.update);
    window.removeEventListener("pagehide", this.leaving);
    window.removeEventListener("beforeunload", this.leaving);
    window.removeEventListener("pageshow", this.returned);
    window.removeEventListener("panda-force:notifications-changed", this.update);
    document.removeEventListener("visibilitychange", this.update);
    this.view.dispose();
    this.actions.close();
  }
}
