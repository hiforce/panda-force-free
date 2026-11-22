import type { CreationNotification } from "../../../shared/creation/contracts.js";
import { creationNotificationCursor } from "../../../shared/creation/notifications.js";
import type { NotificationItem } from "../../../shared/notifications/contracts.js";
import { DocumentError } from "../../documents/errors.js";
import { InvalidNotificationRequest, type NotificationSource } from "../../notifications/center.js";
import { CreationError } from "../contracts.js";
import type { CreationService } from "../service.js";
import { creationNotificationPosition } from "../validation.js";

export type CreationNotificationReader = Pick<CreationService, "notifications" | "readNotification">;

function present(item: CreationNotification): Omit<NotificationItem, "source"> {
  return {
    id: creationNotificationCursor(item),
    title: item.title,
    createdAt: item.createdAt,
    readAt: item.readAt,
    category: item.kind,
    action: { type: "intent", name: "creation.deliverable", data: item.artifact },
  };
}

function position(id: string) {
  try {
    return creationNotificationPosition(id);
  } catch {
    throw new InvalidNotificationRequest();
  }
}

const absent = (error: unknown) =>
  (error instanceof DocumentError && [403, 404].includes(error.status)) ||
  (error instanceof CreationError && error.code === "notFound");

export function creationNotificationSource(
  id: string,
  reader: (owner: string) => CreationNotificationReader | undefined | Promise<CreationNotificationReader | undefined>,
): NotificationSource {
  const resolve = async (owner: string) => {
    try {
      return await reader(owner);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  };
  return {
    id,
    async preview(owner) {
      const result = await (await resolve(owner))?.notifications(owner, "preview");
      return { items: result?.items.map(present) ?? [], unreadCount: result?.unreadCount ?? 0 };
    },
    async history(owner, cursor) {
      const before = cursor === null ? undefined : position(cursor);
      const result = await (await resolve(owner))?.notifications(owner, { before });
      return { items: result?.items.map(present) ?? [], more: Boolean(result?.nextCursor) };
    },
    async read(owner, id) {
      const { taskId, generation } = position(id);
      try {
        const result = await (await resolve(owner))?.readNotification(owner, { taskId, generation });
        return result?.read ?? false;
      } catch (error) {
        if (absent(error)) return false;
        throw error;
      }
    },
  };
}
