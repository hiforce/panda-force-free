import type { LocalConnectionInput } from "../../shared/connections/contracts.js";
import { ConnectionError } from "./errors.js";

export function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new ConnectionError("invalidInput");
  return value;
}
export function connectionText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new ConnectionError("invalidInput");
  return value.trim();
}
export function connectionVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ConnectionError("invalidInput");
  return value;
}
export function connectionUrl(value: unknown) {
  let url: URL;
  try {
    url = new URL(connectionText(value, 660));
  } catch {
    throw new ConnectionError("invalidUrl");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname)
  )
    throw new ConnectionError("invalidUrl");
  return url.href;
}
export function localConnectionInput(value: unknown): LocalConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["id", "projectId", "name", "connector", "root", "directory", "publicUrl"].includes(key),
    ) ||
    input.connector !== "local-site"
  )
    throw new ConnectionError("invalidInput");
  const root = connectionText(input.root, 64),
    directory = connectionText(input.directory, 160);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(root) || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(directory))
    throw new ConnectionError("invalidPath");
  return {
    id: connectionId(input.id),
    projectId: connectionId(input.projectId),
    name: connectionText(input.name, 120),
    connector: "local-site",
    root,
    directory,
    publicUrl: connectionUrl(input.publicUrl),
  };
}
