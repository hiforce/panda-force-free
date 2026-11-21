import { isRecord } from "../records.js";
import type { ApplicationRunFailure } from "./application-tools.js";

/** Classify operational failures without returning provider messages, request IDs or credentials. */
export function applicationRunFailure(value: unknown): ApplicationRunFailure {
  if (!isRecord(value)) return "failed";
  const raw = value.codexErrorInfo ?? value.codex_error_info ?? value.code;
  const code = typeof raw === "string" ? raw.replace(/[^a-z]/gi, "").toLowerCase() : "";
  if (["ratelimitexceeded", "usagelimitexceeded", "insufficientquota"].includes(code) || value.status === 429)
    return "rateLimited";
  if (
    ["unauthorized", "authenticationfailed", "authentication", "invalidapikey"].includes(code) ||
    value.status === 401
  )
    return "authentication";
  if (["httpconnectionfailed", "streamconnectionfailed", "serveroverloaded", "unavailable", "timeout"].includes(code))
    return "unavailable";
  return "failed";
}
