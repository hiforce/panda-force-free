/** Error messages never include provider response bodies, authorization codes or tokens. */
export class OAuthError extends Error {
  constructor(
    readonly code:
      | "invalidCallback"
      | "invalidOAuthConfig"
      | "invalidOAuthInput"
      | "invalidOAuthResponse"
      | "authorizationRejected"
      | "authorizationRateLimited"
      | "authorizationUnavailable"
      | "authorizationExpired"
      | "authorizationConsumed",
    readonly status?: number,
  ) {
    super(code);
  }
}
