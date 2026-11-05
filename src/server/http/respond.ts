import type { ServerResponse } from "node:http";
import { errorPayload } from "../i18n/error-payload.js";

/** Standard headers for every JSON API response. */
export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

/** Write a JSON body with the standard header set. */
export function respondJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, jsonHeaders(extra));
  const errorBody = body as { error?: unknown; messageId?: string; messageArgs?: Record<string, unknown> };
  const value =
    status >= 400 && typeof errorBody?.error === "string"
      ? { ...(body as object), ...errorPayload(errorBody.messageId || errorBody.error, errorBody.messageArgs) }
      : body;
  res.end(JSON.stringify(value));
}

/** Reject a non-allowed HTTP method, advertising the allowed ones. */
export function respondMethodNotAllowed(res: ServerResponse, allow: string) {
  respondJson(res, 405, errorPayload("errors.methodNotAllowed"), { allow });
}

/** Map a caught error to a JSON error payload. */
export function respondError(res: ServerResponse, status: number, error: unknown) {
  const known = error as { messageId?: string; messageArgs?: Record<string, unknown> };
  respondJson(
    res,
    status,
    known?.messageId
      ? errorPayload(known.messageId, known.messageArgs)
      : { error: error instanceof Error ? error.message : String(error) },
  );
}
