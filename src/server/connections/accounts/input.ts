import type { SocialAccountInput, SocialAccountUpdate } from "../../../shared/connections/accounts.js";
import { connectionId, connectionText, connectionVersion } from "../validation.js";
import { ConnectionError } from "../errors.js";
import type { AccountApplication } from "./ports.js";

function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ConnectionError("invalidInput");
  return value as Record<string, unknown>;
}
function application(value: unknown): AccountApplication {
  const input = record(value, ["clientId", "clientSecret", "callbackUrl"]);
  if (
    typeof input.clientId !== "string" ||
    typeof input.callbackUrl !== "string" ||
    (input.clientSecret !== undefined && typeof input.clientSecret !== "string")
  )
    throw new ConnectionError("invalidInput");
  return {
    clientId: input.clientId,
    callbackUrl: input.callbackUrl,
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
  };
}
export function accountInput(value: unknown): SocialAccountInput {
  const input = record(value, ["id", "projectId", "name", "provider", "application"]);
  if (input.provider !== "x") throw new ConnectionError("unsupportedConnector");
  return {
    id: connectionId(input.id),
    projectId: connectionId(input.projectId),
    name: connectionText(input.name, 120),
    provider: "x",
    application: application(input.application),
  };
}
export function accountUpdate(value: unknown): SocialAccountUpdate {
  const input = record(value, ["version", "name", "enabled", "application"]);
  if (typeof input.enabled !== "boolean") throw new ConnectionError("invalidInput");
  return {
    version: connectionVersion(input.version),
    name: connectionText(input.name, 120),
    enabled: input.enabled,
    ...(input.application === undefined ? {} : { application: application(input.application) }),
  };
}
