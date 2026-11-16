import { request } from "../http-client.js";
import { errorText } from "../i18n.js";
import type { Translate } from "../../shared/i18n/messages.js";

export async function usersRequest<T>(
  t: Translate,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(path, {
    method,
    cache: "no-store",
    signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(t("users.unavailable"));
  }
  if (!response.ok) throw new Error(errorText(payload, t, "users.unavailable"));
  return payload as T;
}
