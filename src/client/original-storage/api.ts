import { request } from "../http-client.js";
import { originalStorageErrorMessages } from "../../shared/storage/messages.js";
import type { OriginalStorageErrorCode } from "../../shared/storage/contracts.js";
export class OriginalStorageRequestError extends Error {
  constructor(
    readonly code: OriginalStorageErrorCode,
    readonly status = 0,
  ) {
    super(code);
  }
}
export async function originalStorageRequest<T>(path = "", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request("/api/system/storage" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const raw = String(value?.error?.code ?? "storageUnavailable"),
      code = Object.hasOwn(originalStorageErrorMessages, raw)
        ? (raw as OriginalStorageErrorCode)
        : "storageUnavailable";
    throw new OriginalStorageRequestError(code, response.status);
  }
  if (value === null && path.startsWith("/operations/")) return value as T;
  if (!value || typeof value !== "object") throw new OriginalStorageRequestError("storageUnavailable");
  return value;
}
