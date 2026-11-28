import { request } from "../http-client.js";
import { storageConnectionsPath, type RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";
import type { OriginalStorageCredentials } from "../../shared/storage/contracts.js";
import type { MessageId } from "../../shared/i18n/messages.js";

const messages = new Set<MessageId>([
  "storageConnections.administrator",
  "storageConnections.invalid",
  "storageConnections.conflict",
  "storageConnections.unavailable",
]);
async function storageRequest(init: RequestInit) {
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15000)]);
  const response = await request(storageConnectionsPath, { cache: "no-store", ...init, signal });
  const result = await response.json();
  if (!response.ok) {
    const id = result?.error?.messageId;
    throw new StorageConnectionError(messages.has(id) ? id : "storageConnections.unavailable");
  }
  return result;
}
export class StorageConnectionError extends Error {
  constructor(readonly messageId: MessageId) {
    super(messageId);
  }
}
export const storageConnectionsApi = {
  async list(signal: AbortSignal): Promise<{ connections: RegisteredStorageConnection[] }> {
    return storageRequest({ signal });
  },
  async rotate(input: {
    id: string;
    operationId: string;
    credentialRevision: number;
    credentials: OriginalStorageCredentials;
  }): Promise<{ saved: boolean }> {
    return storageRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rotate", ...input }),
    });
  },
  async add(
    input: Record<string, FormDataEntryValue | boolean>,
  ): Promise<{ connection?: RegisteredStorageConnection; authorizationUrl?: string }> {
    return storageRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  },
};
