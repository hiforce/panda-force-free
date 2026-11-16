import type { AsyncPublicationStore } from "../async-ports.js";
import { CredentialError } from "../credentials/errors.js";
import type { CredentialEncryption, CredentialStore } from "../credentials/ports.js";
import { OAuthError } from "../oauth/errors.js";
import { oauthTokenValue } from "../oauth/tokens.js";
import type { AccountTokenAccess, AccountTokenOwner, AccountTokenTarget } from "./token-port.js";
const binding = (target: AccountTokenTarget) => ({
  ownerId: target.ownerId,
  connectionId: target.connectionId,
  connectorId: target.providerId,
});
/** Coordinates credential refresh without publication permissions or platform payloads. */
export class MySQLAccountTokens {
  constructor(
    private owners: AsyncPublicationStore<AccountTokenOwner>,
    private secrets: AsyncPublicationStore<CredentialStore>,
    private cipher: CredentialEncryption,
    private now = Date.now,
  ) {}
  private async current(target: AccountTokenTarget, scopes: readonly string[]) {
    const next = await this.owners.accessTarget(target.ownerId, target.connectionId);
    if (
      next.projectId !== target.projectId ||
      next.connectionVersion !== target.connectionVersion ||
      next.providerId !== target.providerId ||
      next.configuration !== target.configuration ||
      next.accountId !== target.accountId ||
      next.credentialRevision !== target.credentialRevision
    )
      throw new CredentialError("credentialConflict");
    if (scopes.some((scope) => !next.scopes.includes(scope))) throw new OAuthError("authorizationRejected");
    const metadata = (await this.secrets.get(binding(next))).metadata;
    if (metadata.revision !== next.credentialRevision) throw new CredentialError("credentialConflict");
    return next;
  }
  private async read(target: AccountTokenTarget, scopes: readonly string[]) {
    await this.current(target, scopes);
    const saved = await this.secrets.get(binding(target));
    if (saved.metadata.refreshState !== "ready")
      throw new CredentialError(saved.metadata.refreshState === "pending" ? "refreshBusy" : "refreshFailed");
    const plain = await this.cipher.open(binding(target), saved.envelope);
    await this.current(target, scopes);
    if ((await this.secrets.get(binding(target))).metadata.refreshState !== "ready")
      throw new CredentialError("refreshBusy");
    if (plain.accountId !== target.accountId) throw new OAuthError("authorizationRejected");
    const tokens = oauthTokenValue(plain);
    if (scopes.some((scope) => !tokens.scopes.includes(scope))) throw new OAuthError("authorizationRejected");
    return tokens;
  }
  async access(owner: string, id: string, version: number, scopes: readonly string[]): Promise<AccountTokenAccess> {
    let target = await this.owners.accessTarget(owner, id);
    if (target.connectionVersion !== version) throw new CredentialError("credentialConflict");
    let tokens = await this.read(target, scopes);
    if (tokens.expiresAt <= this.now() + 60000) {
      if (!tokens.refreshToken) throw new OAuthError("authorizationExpired");
      const provider = await this.owners.provider(target);
      await this.current(target, scopes);
      const lease = await this.secrets.acquire(binding(target), target.credentialRevision, 60000);
      try {
        tokens = await this.read(target, scopes);
        await this.current(target, scopes);
        await this.secrets.dispatch(binding(target), lease);
        const next = oauthTokenValue(await provider.refresh(tokens));
        if (next.expiresAt <= this.now() + 30000) throw new OAuthError("invalidOAuthResponse");
        const identity = await provider.identity(next);
        if (identity.id !== target.accountId) throw new OAuthError("authorizationRejected");
        const secret = await this.cipher.seal(binding(target), { ...next, accountId: identity.id });
        await this.current(target, scopes);
        await this.owners.rotate(target, lease, secret, { expiresAt: next.expiresAt, scopes: next.scopes });
      } finally {
        await this.secrets.release(binding(target), lease);
      }
      target = await this.owners.accessTarget(owner, id);
      if (target.connectionVersion !== version) throw new CredentialError("credentialConflict");
      tokens = await this.read(target, scopes);
    }
    const guard = async () => {
      await this.current(target, scopes);
      if (tokens.expiresAt <= this.now()) throw new OAuthError("authorizationExpired");
      const status = (await this.secrets.get(binding(target))).metadata.refreshState;
      if (status !== "ready") throw new CredentialError(status === "pending" ? "refreshBusy" : "refreshFailed");
    };
    await guard();
    return { accessToken: tokens.accessToken, accountId: target.accountId, guard };
  }
}
