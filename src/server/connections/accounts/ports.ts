import type { OAuthProvider } from "../oauth/ports.js";

export interface AccountApplication {
  clientId: string;
  clientSecret?: string;
  callbackUrl: string;
}
/** Provider factories validate application configuration without contacting the platform. */
export type AccountProviderFactory = (configuration: AccountApplication) => OAuthProvider;
