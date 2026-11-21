import { createHash } from "node:crypto";
import { HarnessError } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { HarnessCredentialSnapshot } from "./contracts.js";

export const MAX_CREDENTIAL_BYTES = 256 * 1024;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Refresh grants stay exclusively with the account owner, including nested vendor metadata. */
export function accessCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(accessCredentials);
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !/refresh.?token/i.test(key))
          .map(([key, entry]) => [key, accessCredentials(entry)]),
      )
    : value;
}

export function grokCredentialSnapshot(value: unknown): HarnessCredentialSnapshot {
  if (!isRecord(value)) throw new HarnessError("authentication", 503);
  const entries = Object.entries(value).filter(
    ([, entry]) => isRecord(entry) && typeof entry.key === "string" && entry.key,
  );
  // Managed renewal has one explicit account owner. Ambiguous account files require separate profiles/homes.
  if (entries.length !== 1) throw new HarnessError("authentication", 503);
  const [scope, raw] = entries[0]!;
  if (!isRecord(raw) || typeof raw.user_id !== "string" || !raw.user_id) throw new HarnessError("authentication", 503);
  const credentials = accessCredentials({ [scope]: raw }) as Record<string, unknown>;
  let expiresAt: number | null = null;
  if (typeof raw.expires_at === "string") {
    expiresAt = Date.parse(raw.expires_at);
    if (!Number.isFinite(expiresAt)) throw new HarnessError("authentication", 503);
  }
  return {
    credentials,
    generation: digest(credentials),
    principal: digest([scope, raw.user_id, raw.team_id ?? null, raw.principal_id ?? null]),
    expiresAt,
  };
}

export function decodeCredentialSnapshot(value: unknown): HarnessCredentialSnapshot {
  if (!isRecord(value)) throw new HarnessError("invalidProtocol", 503);
  const snapshot = grokCredentialSnapshot(value.credentials);
  if (
    snapshot.generation !== value.generation ||
    snapshot.principal !== value.principal ||
    snapshot.expiresAt !== value.expiresAt ||
    JSON.stringify(snapshot.credentials) !== JSON.stringify(value.credentials)
  )
    throw new HarnessError("invalidProtocol", 503);
  return snapshot;
}
