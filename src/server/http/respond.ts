import { errorPayload } from "./error-payload.js";
import type { ServerResponse } from "node:http";

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
  res.end(JSON.stringify(body));
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
