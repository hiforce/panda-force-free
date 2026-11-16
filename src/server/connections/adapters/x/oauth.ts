import { createHash } from "node:crypto";
import type { OAuthProvider, OAuthJsonTransport, OAuthTokens } from "../../oauth/ports.js";
import { OAuthError } from "../../oauth/errors.js";
import { oauthString, xTokens, xAccount, xScopes } from "./oauth-values.js";

export interface XOAuthConfiguration {
  clientId: string;
  clientSecret?: string;
  callbackUrl: string;
}

/** The X adapter owns protocol fields; it neither grants article entitlement nor writes publication content. */
export class XOAuthProvider implements OAuthProvider {
  readonly configuration: string;
  private config: XOAuthConfiguration;
  constructor(
    config: XOAuthConfiguration,
    private http: OAuthJsonTransport,
    private now = Date.now,
  ) {
    let callback: URL;
    try {
      callback = new URL(config.callbackUrl);
    } catch {
      throw new OAuthError("invalidOAuthConfig");
    }
    if (
      !oauthString(config.clientId, 1024) ||
      config.clientId.includes(":") ||
      (config.clientSecret !== undefined && !oauthString(config.clientSecret, 2048)) ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.search ||
      (callback.protocol !== "https:" &&
        !(callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)))
    )
      throw new OAuthError("invalidOAuthConfig");
    this.config = { ...config, callbackUrl: callback.href };
    this.configuration = createHash("sha256")
      .update(JSON.stringify([this.config, xScopes]))
      .digest("hex");
  }
  authorize(state: string, challenge: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new OAuthError("invalidOAuthInput");
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: xScopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }
  async exchange(code: string, verifier: string) {
    if (!oauthString(code, 4096) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new OAuthError("invalidOAuthInput");
    return this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.config.callbackUrl,
    });
  }
  async refresh(tokens: OAuthTokens) {
    if (!oauthString(tokens.refreshToken, 8192)) throw new OAuthError("authorizationRejected");
    return this.token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken! }, tokens);
  }
  private async token(fields: Record<string, string>, previous?: OAuthTokens) {
    const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body = new URLSearchParams(fields);
    if (this.config.clientSecret)
      headers.Authorization =
        "Basic " + Buffer.from(this.config.clientId + ":" + this.config.clientSecret).toString("base64");
    else body.set("client_id", this.config.clientId);
    const value = await this.http.request("https://api.x.com/2/oauth2/token", { method: "POST", headers, body });
    return xTokens(value, this.now(), previous);
  }
  async identity(tokens: OAuthTokens) {
    if (!oauthString(tokens.accessToken, 8192) || tokens.expiresAt <= this.now())
      throw new OAuthError("authorizationRejected");
    return xAccount(
      await this.http.request("https://api.x.com/2/users/me", {
        headers: { Authorization: "Bearer " + tokens.accessToken, Accept: "application/json" },
      }),
    );
  }
}
