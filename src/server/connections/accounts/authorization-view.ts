import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { CredentialStore } from "../credentials/ports.js";
import { CredentialError } from "../credentials/errors.js";

/** A public projection of refresh health. Reading it never decrypts or refreshes credentials. */
export function accountAuthorizationView(
  owner: string,
  account: SocialAccount,
  secrets: CredentialStore,
): SocialAccount {
  let authorizationState: SocialAccount["authorizationState"] = "unconnected";
  if (account.enabled && account.account && account.grant) {
    try {
      const { metadata } = secrets.get({ ownerId: owner, connectionId: account.id, connectorId: account.provider });
      authorizationState =
        metadata.revision !== account.grant.credentialRevision || metadata.refreshState === "uncertain"
          ? "reauthorizationRequired"
          : metadata.refreshState === "pending"
            ? "refreshing"
            : "ready";
    } catch (error) {
      if (!(error instanceof CredentialError) || !["credentialMissing", "unreadableCredential"].includes(error.code))
        throw error;
      authorizationState = "reauthorizationRequired";
    }
  }
  return { ...account, authorizationState };
}
