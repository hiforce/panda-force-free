import { request } from "../http-client.js";
import {
  REMOTE_CONNECTIONS_PATH,
  REMOTE_HOST_KEY_PATH,
  type RemoteHost,
  type RemoteHostKey,
  type RemoteConnection,
  type RemoteConnectionInput,
  type RemoteErrorCode,
} from "../../shared/workspace-tools/remote.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { isMessageId } from "../../shared/i18n/message-id.js";

export class RemoteApiError extends Error {
  constructor(
    readonly status: number,
    readonly messageId: MessageId,
  ) {
    super(messageId);
  }
}

async function call<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(path, {
    method,
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message: MessageId =
      typeof payload?.messageId === "string" &&
      payload.messageId.startsWith("remoteTools.") &&
      isMessageId(payload.messageId)
        ? (payload.messageId as `remoteTools.${RemoteErrorCode}`)
        : response.status === 401 || response.status === 403
          ? "remoteTools.denied"
          : "remoteTools.unavailable";
    throw new RemoteApiError(response.status, message);
  }
  return response.json();
}

export const remoteApi = {
  list: (signal: AbortSignal) => call<{ items: RemoteConnection[] }>(REMOTE_CONNECTIONS_PATH, "GET", undefined, signal),
  detail: (id: string, signal?: AbortSignal) =>
    call<{ connection: RemoteConnection }>(
      REMOTE_CONNECTIONS_PATH + "?" + new URLSearchParams({ id }),
      "GET",
      undefined,
      signal,
    ),
  hostKey: (target: RemoteHost, signal: AbortSignal) =>
    call<RemoteHostKey>(REMOTE_HOST_KEY_PATH, "POST", target, signal),
  save: (profile: RemoteConnectionInput) =>
    call<{ connection: RemoteConnection }>(REMOTE_CONNECTIONS_PATH, "POST", profile),
  remove: ({ id, version }: RemoteConnection) =>
    call<{ removed: true }>(REMOTE_CONNECTIONS_PATH, "DELETE", { id, version }),
};
