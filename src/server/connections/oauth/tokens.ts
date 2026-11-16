import type { OAuthTokens } from "./ports.js";
import { OAuthError } from "./errors.js";

/** Validate decrypted values at the credential boundary, not in platform-specific callers. */
export function oauthTokenValue(value: unknown): OAuthTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError("invalidOAuthResponse");
  const tokens = value as OAuthTokens;
  if (
    typeof tokens.accessToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(tokens.accessToken) ||
    (tokens.refreshToken !== undefined &&
      (typeof tokens.refreshToken !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(tokens.refreshToken))) ||
    !Number.isSafeInteger(tokens.expiresAt) ||
    tokens.expiresAt < 1 ||
    !Array.isArray(tokens.scopes) ||
    tokens.scopes.length > 50 ||
    tokens.scopes.some((scope) => typeof scope !== "string" || !/^[a-z][a-z0-9._-]{0,99}$/.test(scope))
  )
    throw new OAuthError("invalidOAuthResponse");
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    expiresAt: tokens.expiresAt,
    scopes: [...new Set(tokens.scopes)],
  };
}
