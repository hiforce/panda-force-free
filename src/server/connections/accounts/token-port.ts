import type { CredentialLease, SecretEnvelope } from "../credentials/ports.js";
import type { OAuthAttemptTarget } from "../oauth/attempts.js";
import type { OAuthProvider, OAuthTokens } from "../oauth/ports.js";

export interface AccountTokenTarget extends OAuthAttemptTarget {
  accountId: string;
  credentialRevision: number;
  scopes: string[];
}
export interface AccountTokenOwner {
  accessTarget(owner: string, id: string): AccountTokenTarget;
  provider(target: OAuthAttemptTarget): Promise<OAuthProvider>;
  rotate(
    target: AccountTokenTarget,
    lease: CredentialLease,
    secret: SecretEnvelope,
    grant: Pick<OAuthTokens, "expiresAt" | "scopes">,
  ): void;
}
/** Only trusted platform adapters receive bearer tokens. Revalidate immediately before each network dispatch. */
export interface AccountTokenAccess {
  accessToken: string;
  accountId: string;
  guard(): void | Promise<void>;
}
