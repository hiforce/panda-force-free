import { ConnectionError } from "../errors.js";

/** Remote paths are POSIX names, never shell expressions or decoded URLs. */
export function sftpDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    value.trim() !== value ||
    !value.startsWith("/") ||
    /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
    throw new ConnectionError("invalidPath");
  const parts = value.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255))
    throw new ConnectionError("invalidPath");
  return value;
}
