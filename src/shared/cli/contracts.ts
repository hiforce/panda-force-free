export const CLI_PROTOCOL = 1 as const;
export const CLI_CAPABILITIES = [
  "content:read",
  "search:read",
  "knowledge:read",
  "knowledge:records:read",
  "knowledge:write",
  "knowledge:approve",
  "memory:read",
  "memory:organize",
  "media:read",
  "media:connect",
  "media:admin",
] as const;
export type CliCapability = (typeof CLI_CAPABILITIES)[number];
export type CliClientKind = "codex" | "claude" | "cli";
export interface CliRegistration {
  schema: 1;
  protocol: 1;
  server: string;
  clientId: string;
  kind: CliClientKind;
  credentialRef: "credentials.json";
}
export type CliProjectScope = "selected" | "allAccessible";
export interface CliGrant {
  clientId: string;
  keyId: string;
  owner: string;
  projects: string[];
  projectScope?: CliProjectScope;
  capabilities: CliCapability[];
  expiresAt: number;
}
export type CliErrorCode =
  | "invalidInput"
  | "authenticationRequired"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "limit"
  | "unavailable"
  | "configuration"
  | "notReady"
  | "indexChanged";
export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function cliObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new CliError("invalidInput");
  return value as Record<string, unknown>;
}
export function cliText(value: unknown, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    throw new CliError("invalidInput");
  return value;
}
export function cliId(value: unknown): string {
  const text = cliText(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(text)) throw new CliError("invalidInput");
  return text;
}
export function cliServer(value: unknown): string {
  const text = cliText(value, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliError("invalidInput");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new CliError("invalidInput");
  return url.origin;
}
export function cliRegistration(value: unknown): CliRegistration {
  const p = cliObject(value, ["schema", "protocol", "server", "clientId", "kind", "credentialRef"]);
  if (
    p.schema !== 1 ||
    p.protocol !== CLI_PROTOCOL ||
    !["codex", "claude", "cli"].includes(String(p.kind)) ||
    p.credentialRef !== "credentials.json"
  )
    throw new CliError("invalidInput");
  return {
    schema: 1,
    protocol: 1,
    server: cliServer(p.server),
    clientId: cliId(p.clientId),
    kind: p.kind as CliClientKind,
    credentialRef: "credentials.json",
  };
}
