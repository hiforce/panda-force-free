import type { CreationNotification } from "./contracts.js";

export const CREATION_NOTIFICATION_PREVIEW_SIZE = 5;
export const CREATION_NOTIFICATION_PAGE_SIZE = 12;

export type CreationNotificationPosition = Pick<CreationNotification, "taskId" | "generation" | "createdAt">;

export function creationNotificationCursor(position: CreationNotificationPosition) {
  return `${position.createdAt}.${position.taskId}.${position.generation}`;
}

export function compareCreationNotifications(a: CreationNotificationPosition, b: CreationNotificationPosition) {
  return (
    b.createdAt - a.createdAt || (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0) || b.generation - a.generation
  );
}
