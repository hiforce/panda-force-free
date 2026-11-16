import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { AsyncPublicationStore } from "../async-ports.js";
import { CredentialError } from "../credentials/errors.js";
import type { CredentialStore } from "../credentials/ports.js";
/** Public health reads await the selected relational owner without decrypting or refreshing credentials. */
export async function mysqlAccountAuthorizationView(
  owner: string,
  account: SocialAccount,
  secrets: AsyncPublicationStore<CredentialStore>,
): Promise<SocialAccount> {
  let authorizationState: SocialAccount["authorizationState"] = "unconnected";
  if (account.enabled && account.account && account.grant) {
    try {
      const { metadata } = await secrets.get({
        ownerId: owner,
        connectionId: account.id,
        connectorId: account.provider,
      });
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
