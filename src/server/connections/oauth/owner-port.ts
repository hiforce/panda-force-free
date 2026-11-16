import type { SecretEnvelope } from "../credentials/ports.js";
import type { OAuthAttempt, OAuthAttemptTarget } from "./attempts.js";
import type { OAuthAccount, OAuthProvider, OAuthTokens } from "./ports.js";

/** The composition root supplies project authorization and compare-and-swap account persistence. */
export interface OAuthConnectionOwner {
  /** Requires an enabled connection and the authenticated owner's current project access. */
  current(ownerId: string, connectionId: string): OAuthAttemptTarget;
  /** Resolve encrypted application configuration outside transactions, then recheck the target version. */
  provider(target: OAuthAttemptTarget): Promise<OAuthProvider>;
  /** Recheck version and immutable account identity; writes share the attempt transaction without network or encryption. */
  accept(value: {
    attempt: OAuthAttempt;
    account: OAuthAccount;
    grant: Pick<OAuthTokens, "expiresAt" | "scopes">;
    credential: SecretEnvelope;
  }): { id: string; version: number };
}
