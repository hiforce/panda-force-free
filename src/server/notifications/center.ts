import {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_PREVIEW_SIZE,
  notificationHref,
  type NotificationItem,
  type NotificationPage,
  type NotificationPreview,
} from "../../shared/notifications/contracts.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";

type SourceEntry = Omit<NotificationItem, "source">;
type Cursor = string | null | false;

/** A module or a verified integration owns its records and authorization. Use its stable row cursor as the item ID. */
export interface NotificationSource {
  id: string;
  preview(owner: string): Promise<{ items: SourceEntry[]; unreadCount: number }>;
  history(owner: string, before: string | null): Promise<{ items: SourceEntry[]; more: boolean }>;
  read(owner: string, id: string): Promise<boolean>;
}

export class InvalidNotificationRequest extends Error {}
const sourceId = /^[a-z][a-z0-9-]{0,31}$/;
const itemId = /^[\w.:-]{1,128}$/;
const newestFirst = (a: NotificationItem, b: NotificationItem) => b.createdAt - a.createdAt;

function entry(source: string, value: SourceEntry): NotificationItem {
  const { id, title, createdAt, readAt, category, description, action } = value;
  if (!itemId.test(id) || !Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > 8640000000000000)
    throw new Error("Invalid notification record");
  const href = action?.type === "link" ? notificationHref(action.href) : null;
  return {
    source,
    id,
    title: title.slice(0, 512),
    createdAt,
    readAt,
    category,
    ...(description ? { description: description.slice(0, 8192) } : {}),
    ...(action?.type === "intent"
      ? { action }
      : href && action?.type === "link"
        ? { action: { type: "link", href, label: action.label?.slice(0, 96) } }
        : {}),
  };
}

export class NotificationCenter {
  private readonly sources: ReadonlyMap<string, NotificationSource>;

  constructor(sources: readonly NotificationSource[]) {
    this.sources = new Map(sources.map((provider) => [provider.id, provider]));
    if (sources.length > 16 || this.sources.size !== sources.length || !sources.every(({ id }) => sourceId.test(id)))
      throw new Error("Invalid notification sources");
  }

  async preview(owner: string): Promise<NotificationPreview> {
    const results = await Promise.allSettled(
      Array.from(this.sources, async ([id, provider]) => {
        const batch = await provider.preview(owner);
        return { items: batch.items.map((value) => entry(id, value)), unreadCount: batch.unreadCount };
      }),
    );
    const batches = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const partial = batches.length < results.length;
    if (partial) {
      reportDiagnostic("notification-preview", new Error("Notification source unavailable"));
      if (!batches.length) throw new Error("Notifications unavailable");
    }
    return {
      items: batches
        .flatMap(({ items }) => items)
        .sort((a, b) => Number(a.readAt !== null) - Number(b.readAt !== null) || newestFirst(a, b))
        .slice(0, NOTIFICATION_PREVIEW_SIZE),
      unreadCount: batches.reduce((sum, batch) => sum + batch.unreadCount, 0),
      ...(partial ? { partial } : {}),
    };
  }

  async history(owner: string, cursor: string | null): Promise<NotificationPage> {
    const cursors = this.decodeCursor(cursor);
    const batches = await Promise.all(
      Array.from(this.sources, async ([id, provider]) => {
        const before = cursors.get(id) ?? null;
        const page = before === false ? { items: [], more: false } : await provider.history(owner, before);
        return { id, before, more: page.more, items: page.items.map((value) => entry(id, value)) };
      }),
    );
    // Stable sort preserves a provider's own keyset order for records sharing the same timestamp.
    const items = batches
      .flatMap((batch) => batch.items)
      .sort(newestFirst)
      .slice(0, NOTIFICATION_PAGE_SIZE);
    const next = batches.map(({ id, before, items: batch, more }): [string, Cursor] => {
      const consumed = items.filter((value) => value.source === id);
      if (consumed.length === batch.length && !more) return [id, false];
      return [id, consumed.at(-1)?.id ?? before];
    });
    return {
      items,
      nextCursor: next.some(([, before]) => before !== false)
        ? Buffer.from(JSON.stringify(next)).toString("base64url")
        : null,
    };
  }

  private decodeCursor(cursor: string | null) {
    if (cursor === null) return new Map<string, Cursor>();
    try {
      if (cursor.length > 4096 || !/^[\w-]+$/.test(cursor)) throw new InvalidNotificationRequest();
      const positions: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(positions) || positions.length > 16) throw new InvalidNotificationRequest();
      const result = new Map<string, Cursor>();
      for (const pair of positions) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new InvalidNotificationRequest();
        const [source, before] = pair;
        if (
          typeof source !== "string" ||
          !sourceId.test(source) ||
          result.has(source) ||
          !(before === false || before === null || (typeof before === "string" && itemId.test(before)))
        )
          throw new InvalidNotificationRequest();
        result.set(source, before);
      }
      return result;
    } catch {
      throw new InvalidNotificationRequest();
    }
  }

  async read(owner: string, source: string, id: string) {
    if (!sourceId.test(source) || !itemId.test(id)) throw new InvalidNotificationRequest();
    return (await this.sources.get(source)?.read(owner, id)) ?? false;
  }
}
