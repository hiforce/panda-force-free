import type { SocialAccountRepository } from "./accounts/repository.js";
import type { AsyncPublicationStore } from "./async-ports.js";
import type { CredentialStore } from "./credentials/ports.js";
import type { OAuthAttempts } from "./oauth/attempts.js";
import type { ConnectionRepository } from "./repository.js";
/** These facets share one native transaction context; callers never replace or copy the external master-key file. */
export interface ConnectionPersistence {
  records: AsyncPublicationStore<ConnectionRepository>;
  secrets: AsyncPublicationStore<CredentialStore>;
  accounts: AsyncPublicationStore<SocialAccountRepository>;
  attempts: AsyncPublicationStore<OAuthAttempts>;
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
}
