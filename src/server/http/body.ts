import type { IncomingMessage } from "node:http";
import { readRequestBytes, RequestBodyError } from "../request-bytes.js";
export { RequestBodyError } from "../request-bytes.js";
/** JSON routes validate the same bytes checked by the optional cluster boundary. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 256_000): Promise<Record<string, unknown>> {
  const bytes = await readRequestBytes(req, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8") || "{}");
  } catch {
    throw new RequestBodyError("Invalid JSON payload", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestBodyError("JSON body must be an object", 400);
  return value as Record<string, unknown>;
}
