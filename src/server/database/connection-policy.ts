import { isRecord } from "../../shared/records.js";

export interface ConnectionRetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const mysqlStartupRetry: ConnectionRetryPolicy = { attempts: 6, baseDelayMs: 1000, maxDelayMs: 15000 };
export function mysqlConnectionFailure(error: unknown): "transient" | "blocked" | "handshake" | "permanent" {
  if (!isRecord(error)) return "permanent";
  if (Number(error.errno) === 1129 || error.code === "ER_HOST_IS_BLOCKED") return "blocked";
  // Bun can report a server's pre-authentication rejection as an unsupported protocol version.
  if (error.code === "ERR_MYSQL_UNSUPPORTED_PROTOCOL_VERSION") return "handshake";
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ERR_MYSQL_CONNECTION_CLOSED",
    "ERR_MYSQL_CONNECTION_REFUSED",
    "ERR_MYSQL_CONNECTION_TIMEOUT",
    "ERR_MYSQL_CONNECT_TIMEOUT",
    "ERR_MYSQL_CONNECTION_TIMED_OUT",
    "ERR_MYSQL_CONNECTION_LOST",
    "ERR_MYSQL_CONNECTION_FAILED",
  ].includes(String(error.code))
    ? "transient"
    : "permanent";
}
/** Only connection establishment is retried. Business statements and uncertain commits are never replayed here. */
export async function retryMySQLConnection<T>(
  connect: () => Promise<T>,
  policy: ConnectionRetryPolicy,
  options: {
    wait?: (ms: number) => Promise<unknown>;
    random?: () => number;
    retry?: (attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  if (
    !Number.isSafeInteger(policy.attempts) ||
    policy.attempts < 1 ||
    policy.attempts > 8 ||
    !Number.isFinite(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs
  )
    throw Error("invalidDatabaseRetryPolicy");
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (attempt >= policy.attempts || mysqlConnectionFailure(error) !== "transient") throw error;
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(ceiling * (0.8 + (options.random ?? Math.random)() * 0.2));
      options.retry?.(attempt + 1, delay);
      await (options.wait ?? Bun.sleep)(delay);
    }
  }
}
