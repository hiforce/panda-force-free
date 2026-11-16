import { request } from "../http-client.js";
import type { ContentAccessView } from "../../shared/content-access.js";
export async function contentAccessRequest<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request("/api/content-access" + path, {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.code === "string" ? result.code : "unavailable");
  return result as T;
}
export const readContentAccess = (signal?: AbortSignal) =>
  contentAccessRequest<ContentAccessView>("", "GET", undefined, signal);
