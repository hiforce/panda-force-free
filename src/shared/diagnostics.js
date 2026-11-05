import { errorCode, errorStatus, isTransportSwitch } from "./errors.js";

/** @type {Map<string, number>} */
const reported = new Map();

/** Emit bounded operational metadata; never include URLs, tokens or conversation content.
 * @param {string} scope @param {unknown} error
 */
export function reportDiagnostic(scope, error, { level = "warn", interval = 30_000 } = {}) {
  if (isTransportSwitch(error) || (error instanceof Error && error.name === "AbortError")) return;
  const rawCode = errorCode(error) || (error instanceof Error ? error.name : "unknown");
  const code = /^[a-zA-Z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "unknown";
  const key = scope + ":" + code;
  const now = Date.now(),
    previous = reported.get(key);
  if (previous !== undefined && now - previous < interval) return;
  if (reported.size >= 128) {
    const oldest = reported.keys().next().value;
    if (oldest) reported.delete(oldest);
  }
  reported.set(key, now);
  const status = errorStatus(error);
  const record = { scope, code, ...(status ? { status } : {}) };
  if (level === "error") console.error("[PandaForce]", record);
  else console.warn("[PandaForce]", record);
}
