import type { OAuthTokens, OAuthAccount } from "../../oauth/ports.js";
import { OAuthError } from "../../oauth/errors.js";

export const xScopes = ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"] as const;
export function oauthString(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}
export function xTokens(value: Record<string, unknown>, now: number, previous?: OAuthTokens): OAuthTokens {
  if (
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    !oauthString(value.access_token, 8192) ||
    (value.refresh_token !== undefined && !oauthString(value.refresh_token, 8192)) ||
    typeof value.expires_in !== "number" ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in < 1 ||
    value.expires_in > 366 * 86400 ||
    typeof value.scope !== "string" ||
    value.scope.length > 1024
  )
    throw new OAuthError("invalidOAuthResponse");
  const scopes = [...new Set(value.scope.split(" ").filter(Boolean))].sort();
  if (!scopes.length || scopes.some((scope) => !xScopes.includes(scope as (typeof xScopes)[number])))
    throw new OAuthError("invalidOAuthResponse");
  const refreshToken = value.refresh_token as string | undefined;
  return {
    accessToken: value.access_token as string,
    ...(refreshToken || previous?.refreshToken ? { refreshToken: refreshToken || previous!.refreshToken } : {}),
    expiresAt: now + value.expires_in * 1000,
    scopes,
  };
}
export function xAccount(value: Record<string, unknown>): OAuthAccount {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new OAuthError("invalidOAuthResponse");
  const input = data as Record<string, unknown>;
  if (
    typeof input.id !== "string" ||
    !/^[1-9][0-9]{0,24}$/.test(input.id) ||
    typeof input.username !== "string" ||
    !/^[a-zA-Z0-9_]{1,15}$/.test(input.username) ||
    typeof input.name !== "string" ||
    !input.name ||
    input.name.length > 200 ||
    /[\p{Cc}\p{Cs}]/u.test(input.name)
  )
    throw new OAuthError("invalidOAuthResponse");
  return { id: input.id, username: input.username, name: input.name };
}
