import { request } from "../http-client.js";
import { errorText } from "../i18n.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { HarnessCatalog, HarnessConversationSnapshot } from "../../shared/harness/contracts.js";
import type { HarnessPermission } from "../../shared/harness/contracts.js";
export type HarnessSnapshot = HarnessConversationSnapshot & { permissions: HarnessPermission[] };
export const conversationsPath = "/api/personal/harness/conversations";
export function harnessApi(t: Translate) {
  return async function api<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    try {
      const response = await request(path, {
        method,
        cache: "no-store",
        signal: signal ?? AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(errorText(value, t, "harness.errorUnavailable")), {
          code: typeof value === "object" && value && "code" in value ? value.code : "unavailable",
        });
      return value as T;
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw Object.assign(new Error(t("harness.errorUnavailable")), { code: "unavailable" });
    }
  };
}
export function validHarnessCatalog(value: HarnessCatalog) {
  return (
    value &&
    Array.isArray(value.runtimes) &&
    Array.isArray(value.profiles) &&
    typeof value.defaultRuntimeId === "string"
  );
}
