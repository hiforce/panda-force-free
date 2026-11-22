export const NOTIFICATION_PREVIEW_SIZE = 5;
export const NOTIFICATION_PAGE_SIZE = 12;

export type NotificationCategory = "notice" | "document" | "image" | "slides" | "video" | "web";

export type NotificationAction =
  { type: "link"; href: string; label?: string } | { type: "intent"; name: string; data: unknown };

export interface NotificationItem {
  source: string;
  id: string;
  title: string;
  description?: string;
  category?: NotificationCategory;
  createdAt: number;
  readAt: number | null;
  action?: NotificationAction;
}

export interface NotificationPreview {
  items: NotificationItem[];
  unreadCount: number;
  partial?: boolean;
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

export function notificationKey(item: Pick<NotificationItem, "source" | "id">) {
  return `${item.source}:${item.id}`;
}

/** An application path or an ordinary web URL. URLs must never carry credentials. */
export function notificationHref(value: string): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}
