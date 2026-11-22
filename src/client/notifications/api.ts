import type { NotificationItem, NotificationPage, NotificationPreview } from "../../shared/notifications/contracts.js";
import { request } from "../http-client.js";

async function json<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await request("/api/notifications" + path, {
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error("Notification request failed");
  return response.json();
}

export const notificationApi = {
  preview: (signal: AbortSignal) => json<NotificationPreview>("?view=preview", signal),
  history: (cursor: string | null, signal: AbortSignal) =>
    json<NotificationPage>("?" + new URLSearchParams({ view: "history", ...(cursor ? { cursor } : {}) }), signal),
  read: ({ source, id }: NotificationItem, signal: AbortSignal) => json("/read", signal, { source, id }),
};
