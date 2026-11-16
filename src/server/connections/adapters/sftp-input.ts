import { isIP } from "node:net";
import { sftpDirectory } from "./sftp-path.js";
import { normalizedSshKey } from "./ssh-key-policy.js";
import type { SftpConnectionInput } from "../../../shared/connections/contracts.js";
import { ConnectionError } from "../errors.js";
import { connectionId, connectionText, connectionUrl } from "../validation.js";

export function sftpInput(value: unknown): SftpConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "projectId",
          "name",
          "connector",
          "host",
          "port",
          "username",
          "hostKey",
          "directory",
          "publicUrl",
        ].includes(key),
    ) ||
    input.connector !== "sftp-site"
  )
    throw new ConnectionError("invalidInput");
  const host = connectionText(input.host, 253).toLowerCase(),
    username = connectionText(input.username, 64),
    hostKey = sftpHostKey(input.hostKey),
    directory = sftpDirectory(input.directory);
  if (
    (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) ||
    host.includes("..") ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(username) ||
    !Number.isInteger(input.port) ||
    Number(input.port) < 1 ||
    Number(input.port) > 65535
  )
    throw new ConnectionError("invalidInput");
  return {
    id: connectionId(input.id),
    projectId: connectionId(input.projectId),
    name: connectionText(input.name, 120),
    connector: "sftp-site",
    host,
    port: Number(input.port),
    username,
    hostKey,
    directory,
    publicUrl: connectionUrl(input.publicUrl),
  };
}
export function sftpHostKey(value: unknown): string {
  const hostKey = connectionText(value, 64);
  if (
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey) ||
    Buffer.from(hostKey.slice(7), "base64").toString("base64").replace(/=+$/, "") !== hostKey.slice(7)
  )
    throw new ConnectionError("invalidHostKey");
  return hostKey;
}
export function sftpCredential(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidCredential");
  const input = value as Record<string, unknown>;
  const secret = (key: string, max: number, optional = false) => {
    if (optional && (input[key] === undefined || input[key] === "")) return "";
    if (typeof input[key] !== "string" || !input[key].length || input[key].length > max || input[key].includes("\0"))
      throw new ConnectionError("invalidCredential");
    return input[key];
  };
  if (input.method === "password" && Object.keys(input).every((key) => ["method", "password"].includes(key)))
    return { method: "password", password: secret("password", 4096) };
  if (
    input.method !== "privateKey" ||
    Object.keys(input).some((key) => !["method", "privateKey", "passphrase"].includes(key))
  )
    throw new ConnectionError("invalidCredential");
  const privateKey = secret("privateKey", 32768),
    passphrase = secret("passphrase", 4096, true);
  return { method: "privateKey", privateKey: normalizedSshKey(privateKey, passphrase) };
}
