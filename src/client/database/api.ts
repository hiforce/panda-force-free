import { request } from "../http-client.js";
export class DatabaseRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
  }
}
export async function databaseRequest<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  statusToken?: string,
): Promise<T> {
  const response = await request("/api/system/database" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(statusToken ? { "X-Panda-Database-Operation": statusToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new DatabaseRequestError(String(value?.error?.code ?? value?.code ?? "databaseUnavailable"), response.status);
  if (!value || typeof value !== "object") throw new DatabaseRequestError("databaseUnavailable", response.status);
  return value;
}
