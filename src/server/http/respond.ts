import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { errorPayload } from "../i18n/error-payload.js";

const responseStarts = new WeakMap<ServerResponse, number>();

/** Observe application handling through response headers without retaining request data. */
export function startResponseTiming(res: ServerResponse) {
  responseStarts.set(res, performance.now());
}

function finishResponseTiming(res: ServerResponse) {
  const started = responseStarts.get(res);
  if (started === undefined) return;
  const previous = res.getHeader("Server-Timing");
  res.setHeader(
    "Server-Timing",
    `${previous ? String(previous) + ", " : ""}app;dur=${(performance.now() - started).toFixed(2)}`,
  );
}

/** Standard headers for every JSON API response. */
export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function responseJson(status: number, body: unknown) {
  const errorBody = body as { error?: unknown; messageId?: string; messageArgs?: Record<string, unknown> };
  const value =
    status >= 400 && typeof errorBody?.error === "string"
      ? { ...(body as object), ...errorPayload(errorBody.messageId || errorBody.error, errorBody.messageArgs) }
      : body;
  return JSON.stringify(value);
}

/** Write a JSON body with the standard header set. */
export function respondJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const data = responseJson(status, body);
  finishResponseTiming(res);
  res.writeHead(status, jsonHeaders(extra));
  res.end(data);
}

/** Compress opted-in read models without caching private data or changing response semantics. */
export function respondReadJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const encodings = (req.headers["accept-encoding"] || "").split(",").map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    const parameter = parameters.find((value) => value.trim().startsWith("q="));
    return { name: name.trim(), quality: parameter ? Number(parameter.trim().slice(2)) : 1 };
  });
  const gzip = encodings.find((entry) => entry.name === "gzip") || encodings.find((entry) => entry.name === "*");
  const data = Buffer.from(responseJson(status, body));
  const previous = res.getHeader("vary");
  const vary = [
    ...new Set([
      ...(previous
        ? String(previous)
            .split(",")
            .map((value) => value.trim())
        : []),
      "Accept-Encoding",
    ]),
  ].join(", ");
  const headers: Record<string, string> = { vary };
  const compressed = data.length >= 1024 && gzip && gzip.quality > 0 && gzip.quality <= 1;
  const payload = compressed ? gzipSync(data, { level: 1 }) : data;
  if (compressed) headers["content-encoding"] = "gzip";
  headers["content-length"] = String(payload.length);
  finishResponseTiming(res);
  res.writeHead(status, jsonHeaders(headers));
  res.end(payload);
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
