import {
  notificationHref,
  notificationKey,
  type NotificationCategory,
  type NotificationItem,
} from "../../shared/notifications/contracts.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { busyIndicator } from "../busy-indicator.js";
import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "../i18n.js";

export type NotificationMode = "preview" | "history" | "detail";
export interface NotificationViewState {
  mode: NotificationMode;
  entries: NotificationItem[];
  detail?: NotificationItem;
  intentLabel?: MessageId;
  direct(entry: NotificationItem): boolean;
  unread: number;
  page: number;
  hasNext: boolean;
  loading: boolean;
  error?: MessageId;
}
type Icon = Parameters<typeof codexIcon>[0];
const kinds = {
  notice: ["notifications.notice", "bell"],
  document: ["creative.document", "file"],
  image: ["creative.image", "image"],
  slides: ["creative.slides", "monitor"],
  video: ["creative.video", "play"],
  web: ["creative.website", "globe"],
} satisfies Record<NotificationCategory, [MessageId, Icon]>;

function button(icon?: Icon) {
  const element = document.createElement("button");
  element.type = "button";
  if (icon) setMessageHtml(element, codexIcon(icon));
  return element;
}

export class NotificationCenterView {
  readonly trigger = button("bell");
  readonly dialog = document.createElement("dialog");
  readonly list = document.createElement("ol");
  private readonly badge = document.createElement("span");
  private readonly heading = document.createElement("h2");
  private readonly close = button("x");
  private readonly back = button("arrowLeft");
  private readonly all = button();
  private readonly previous = button("chevronLeft");
  private readonly next = button("chevronRight");
  private readonly retry = button();
  private readonly delivery = button();
  private readonly link = document.createElement("a");
  private readonly notice = document.createElement("p");
  private readonly busy = document.createElement("span");
  private readonly footer = document.createElement("footer");
  private readonly pagination = document.createElement("div");
  private readonly page = document.createElement("span");
  private readonly detail = document.createElement("section");
  private readonly detailTitle = document.createElement("h3");
  private readonly detailMeta = document.createElement("div");
  private readonly description = document.createElement("p");
  private signature = "";

  constructor(
    private readonly t: Translate,
    actions: {
      preview(): void;
      all(): void;
      back(): void;
      page(delta: -1 | 1): void;
      entry(entry: NotificationItem): void;
      deliver(): void;
      retry(): void;
    },
  ) {
    this.trigger.id = "notificationCenterButton";
    this.trigger.className = "icon-button notification-center-button";
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-controls", "notificationCenterDialog");
    this.trigger.setAttribute("aria-expanded", "false");
    this.badge.className = "notification-center-badge";
    this.badge.setAttribute("aria-hidden", "true");
    this.trigger.append(this.badge);
    requireElement(".top-actions").prepend(this.trigger);

    this.dialog.id = "notificationCenterDialog";
    this.dialog.className = "workbench-dialog notification-center-dialog";
    this.dialog.setAttribute("aria-labelledby", "notificationCenterHeading");
    this.heading.id = "notificationCenterHeading";
    this.heading.tabIndex = -1;
    const header = document.createElement("header");
    this.close.className = this.back.className = this.previous.className = this.next.className = "icon-button";
    this.close.dataset.notificationsClose = "";
    this.back.dataset.notificationsBack = "";
    header.append(this.back, this.heading, this.close);
    this.notice.className = "notification-center-notice";
    this.notice.setAttribute("role", "status");
    this.busy.className = "notification-center-busy";
    setMessageHtml(this.busy, busyIndicator);
    this.busy.setAttribute("role", "status");
    this.list.className = "notification-center-list";
    this.list.setAttribute("role", "list");
    this.detail.className = "notification-detail";
    this.detailMeta.className = "notification-detail-meta";
    this.description.className = "notification-description";
    this.detail.append(this.detailTitle, this.detailMeta, this.description);
    this.pagination.className = "notification-center-pages";
    this.previous.dataset.notificationsPrevious = "";
    this.next.dataset.notificationsNext = "";
    this.page.setAttribute("aria-live", "polite");
    this.pagination.append(this.previous, this.page, this.next);
    this.all.className = "wb-button notification-center-all";
    this.all.dataset.notificationsAll = "";
    this.retry.className = "wb-button notification-center-retry";
    this.delivery.className = "wb-button primary";
    this.delivery.dataset.notificationsDeliver = "";
    this.link.className = "wb-button primary";
    this.link.dataset.notificationsLink = "";
    this.link.rel = "noopener noreferrer";
    this.footer.append(this.all, this.pagination, this.delivery, this.link);
    this.dialog.append(header, this.busy, this.notice, this.retry, this.list, this.detail, this.footer);
    document.body.append(this.dialog);

    this.trigger.onclick = actions.preview;
    this.close.onclick = () => this.dialog.close();
    this.back.onclick = actions.back;
    this.all.onclick = actions.all;
    this.retry.onclick = actions.retry;
    this.previous.onclick = () => actions.page(-1);
    this.next.onclick = () => actions.page(1);
    this.delivery.onclick = actions.deliver;
    this.list.onclick = (event) => {
      const row = (event.target as Element).closest<HTMLButtonElement>("[data-notification-key]");
      const item = this.entries.find((entry) => row?.dataset.notificationKey === notificationKey(entry));
      if (item) actions.entry(item);
    };
    this.dialog.addEventListener("close", () => {
      this.trigger.setAttribute("aria-expanded", "false");
      if (!document.querySelector("dialog[open]")) this.trigger.focus();
    });
    this.dialog.addEventListener("click", (event) => {
      if (event.target !== this.dialog || !event.detail) return;
      const { left, right, top, bottom } = this.dialog.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom)
        this.dialog.close();
    });
    window.addEventListener("resize", this.position);
  }

  private entries: NotificationItem[] = [];
  private readonly position = () => {
    const rect = this.trigger.getBoundingClientRect();
    this.dialog.style.setProperty("--notification-anchor-top", `${Math.round(rect.bottom + 6)}px`);
    this.dialog.style.setProperty(
      "--notification-anchor-end",
      `${Math.max(12, Math.round(innerWidth - rect.right))}px`,
    );
  };
  show() {
    if (this.dialog.open) return;
    this.position();
    this.dialog.showModal();
    this.trigger.setAttribute("aria-expanded", "true");
    this.focus();
  }
  focus(key?: string) {
    const target = key ? this.list.querySelector<HTMLElement>(`[data-notification-key="${CSS.escape(key)}"]`) : null;
    (target ?? this.heading).focus({ preventScroll: true });
  }
  closeDialog() {
    this.dialog.close();
  }
  private timestamp(entry: NotificationItem, full = false) {
    const time = document.createElement("time");
    time.dateTime = new Date(entry.createdAt).toISOString();
    time.textContent = new Intl.DateTimeFormat(
      document.documentElement.lang || "en",
      full
        ? { dateStyle: "long", timeStyle: "short" }
        : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    ).format(entry.createdAt);
    return time;
  }

  render(state: NotificationViewState) {
    const { mode, unread, loading, error } = state;
    this.dialog.dataset.notificationsView = mode;
    localizeAttribute(this.trigger, "aria-label", "notifications.unread", { count: unread }, this.t);
    localizeAttribute(this.trigger, "title", "notifications.title", undefined, this.t);
    setOpaqueText(this.badge, unread > 99 ? "99+" : String(unread));
    this.badge.hidden = !unread;
    localizeText(this.heading, mode === "detail" ? "notifications.details" : "notifications.title", undefined, this.t);
    localizeAttribute(this.close, "aria-label", "common.close", undefined, this.t);
    localizeAttribute(this.back, "aria-label", "common.back", undefined, this.t);
    localizeAttribute(this.previous, "aria-label", "notifications.previous", undefined, this.t);
    localizeAttribute(this.next, "aria-label", "notifications.next", undefined, this.t);
    localizeAttribute(this.busy, "aria-label", "notifications.loading", undefined, this.t);
    localizeText(this.all, "notifications.viewAll", undefined, this.t);
    localizeText(this.page, "notifications.page", { number: state.page }, this.t);
    localizeText(this.retry, "common.retry", undefined, this.t);
    const action = state.detail?.action;
    const href = mode === "detail" && action?.type === "link" ? notificationHref(action.href) : null;
    if (href && action?.type === "link") {
      this.link.setAttribute("href", href);
      this.link.target = href.startsWith("/") ? "_self" : "_blank";
      if (action.label) setOpaqueText(this.link, action.label);
      else localizeText(this.link, "notifications.openLink", undefined, this.t);
    } else this.link.removeAttribute("href");
    this.link.hidden = !href;
    if (state.intentLabel) localizeText(this.delivery, state.intentLabel, undefined, this.t);
    this.busy.hidden = !loading;
    this.back.hidden = mode === "preview";
    this.detail.hidden = mode !== "detail";
    this.list.hidden = mode === "detail" || !state.entries.length;
    this.all.hidden = mode !== "preview";
    this.delivery.hidden = mode !== "detail" || action?.type !== "intent" || !state.intentLabel;
    this.pagination.hidden = mode !== "history" || !(state.page > 1 || state.hasNext);
    this.footer.hidden = this.all.hidden && this.delivery.hidden && this.link.hidden && this.pagination.hidden;
    this.previous.disabled = state.page <= 1 || loading;
    this.next.disabled = !state.hasNext || loading;
    this.retry.hidden = !error;
    const notice = error || (!loading && mode !== "detail" && !state.entries.length ? "notifications.empty" : null);
    this.notice.hidden = !notice;
    if (notice) localizeText(this.notice, notice, undefined, this.t);

    this.entries = state.entries;
    if (state.detail) {
      const [label, icon] = kinds[state.detail.category ?? "notice"] ?? kinds.notice;
      const type = document.createElement("span");
      const stamp = this.timestamp(state.detail, true);
      this.detailTitle.textContent = state.detail.title || this.t("notifications.ready");
      localizeText(type, label, undefined, this.t);
      const picture = document.createElement("span");
      picture.className = "notification-row-icon";
      setMessageHtml(picture, codexIcon(icon));
      this.detailMeta.replaceChildren(picture, type, stamp);
      this.description.hidden = !state.detail.description;
      setOpaqueText(this.description, state.detail.description ?? "");
    }
    const signature = JSON.stringify([state.entries, document.documentElement.lang, mode]);
    if (signature === this.signature) return;
    this.signature = signature;
    const focus = (document.activeElement as HTMLElement)?.dataset.notificationKey;
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(
      ...state.entries.map((entry) => this.row(entry, mode === "preview" && state.direct(entry))),
    );
    this.list.scrollTop = scroll;
    if (focus && !this.list.hidden) this.focus(focus);
  }

  private row(entry: NotificationItem, direct: boolean) {
    const row = document.createElement("li");
    const action = button();
    const [label, icon] = kinds[entry.category ?? "notice"] ?? kinds.notice;
    action.className = "notification-row";
    action.dataset.notificationKey = notificationKey(entry);
    action.dataset.unread = String(entry.readAt === null);
    const picture = document.createElement("span");
    picture.className = "notification-row-icon";
    setMessageHtml(picture, codexIcon(icon));
    const text = document.createElement("span");
    text.className = "notification-row-copy";
    const title = document.createElement("strong");
    title.textContent = entry.title || this.t("notifications.ready");
    title.title = title.textContent;
    const type = document.createElement("span");
    localizeText(type, label, undefined, this.t);
    text.append(title, type);
    const side = document.createElement("span");
    side.className = "notification-row-aside";
    const mark = document.createElement("span");
    mark.className = "notification-row-dot";
    if (entry.readAt === null) {
      const unread = document.createElement("span");
      unread.className = "sr-only";
      localizeText(unread, "notifications.new", undefined, this.t);
      mark.append(unread);
    }
    const arrow = document.createElement("span");
    setMessageHtml(arrow, codexIcon(direct ? "arrowUpRight" : "chevronRight"));
    side.append(mark, this.timestamp(entry), arrow);
    action.append(picture, text, side);
    row.append(action);
    return row;
  }
  dispose() {
    window.removeEventListener("resize", this.position);
    this.trigger.remove();
    this.dialog.remove();
  }
}
