/** Tokens stay inside trusted connection services and encrypted persistence. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}
export interface OAuthAccount {
  id: string;
  username: string;
  name: string;
}
export interface OAuthProvider {
  readonly configuration: string;
  authorize(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<OAuthTokens>;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  identity(tokens: OAuthTokens): Promise<OAuthAccount>;
}
export interface OAuthJsonTransport {
  request(url: string, init: RequestInit): Promise<Record<string, unknown>>;
}
