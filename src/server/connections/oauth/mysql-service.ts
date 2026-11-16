import type { AsyncPublicationStore } from "../async-ports.js";
import type { CredentialEncryption } from "../credentials/ports.js";
import type { ConnectionPersistence } from "../persistence.js";
import { OAuthError } from "./errors.js";
import type { OAuthAttempt } from "./mysql-attempts.js";
import type { OAuthConnectionOwner } from "./owner-port.js";
import { createPkce } from "./pkce.js";
import { oauthTokenValue } from "./tokens.js";
const binding = (attempt: OAuthAttempt) => ({
  connectionId: attempt.id,
  connectorId: "oauth",
  ownerId: attempt.ownerId,
});
const publicStatus = (attempt: OAuthAttempt) => ({
  id: attempt.id,
  connectionId: attempt.connectionId,
  phase: attempt.phase,
  expiresAt: attempt.expiresAt,
});
/** Consent and identity verification never grant permission to publish an article or post. */
export class MySQLOAuthConsent {
  constructor(
    private attempts: ConnectionPersistence["attempts"],
    private cipher: CredentialEncryption,
    private owners: AsyncPublicationStore<OAuthConnectionOwner>,
  ) {}
  private async current(owner: string, connection: string) {
    const context = await this.owners.current(owner, connection);
    if (context.ownerId !== owner || context.connectionId !== connection) throw new OAuthError("authorizationRejected");
    return context;
  }
  private async unchanged(attempt: OAuthAttempt) {
    const target = await this.current(attempt.ownerId, attempt.connectionId);
    if (
      target.projectId !== attempt.projectId ||
      target.connectionVersion !== attempt.connectionVersion ||
      target.providerId !== attempt.providerId ||
      target.configuration !== attempt.configuration
    )
      throw new OAuthError("authorizationRejected");
    return target;
  }
  private async provider(attempt: OAuthAttempt) {
    const provider = await this.owners.provider(await this.unchanged(attempt));
    await this.unchanged(attempt);
    if (provider.configuration !== attempt.configuration) throw new OAuthError("authorizationRejected");
    return provider;
  }
  async start(owner: string, connection: string) {
    const context = await this.current(owner, connection),
      attempt = await this.attempts.reserve(context),
      keys = createPkce();
    try {
      const provider = await this.provider(attempt);
      const url = provider.authorize(keys.state, keys.challenge);
      const secret = await this.cipher.seal(binding(attempt), { kind: "pkce", verifier: keys.verifier });
      const prepared = await this.attempts.prepare(owner, attempt.id, keys.state, secret, async (value) => {
        await this.unchanged(value);
      });
      return { ...publicStatus(prepared), url };
    } catch (error) {
      await this.abandon(attempt);
      throw error;
    }
  }
  private async abandon(attempt: OAuthAttempt) {
    try {
      await this.attempts.abandon(attempt.ownerId, attempt.id);
    } catch (error) {
      if (!(error instanceof OAuthError && error.code === "authorizationExpired")) throw error;
    }
  }
  async stateStatus(owner: string, state: string) {
    return publicStatus(await this.attempts.lookup(owner, state));
  }
  async status(owner: string, id: string) {
    return publicStatus(await this.attempts.status(owner, id));
  }
  async callback(owner: string, state: string, code: string) {
    const previous = await this.attempts.lookup(owner, state);
    if (previous.phase === "verifying") return await this.verify(owner, previous.id);
    if (previous.phase !== "prepared") return publicStatus(previous);
    const { attempt, secret } = await this.attempts.claim(owner, state, async (value) => {
      await this.unchanged(value);
    });
    try {
      const provider = await this.provider(attempt);
      const value = await this.cipher.open(binding(attempt), secret);
      if (value.kind !== "pkce" || typeof value.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier))
        throw new OAuthError("invalidOAuthInput");
      await this.unchanged(attempt);
      const tokens = oauthTokenValue(await provider.exchange(code, value.verifier));
      const encrypted = await this.cipher.seal(binding(attempt), { kind: "tokens", tokens });
      await this.attempts.stage(owner, attempt.id, encrypted, async (value) => {
        await this.unchanged(value);
      });
    } catch (error) {
      // Expiry may already have removed the record. Never replay a consumed authorization code.
      await this.abandon(attempt);
      throw error;
    }
    return await this.verify(owner, attempt.id);
  }
  async verify(owner: string, id: string) {
    const status = await this.attempts.status(owner, id);
    if (status.phase === "complete") return publicStatus(status);
    const { attempt, secret } = await this.attempts.pending(owner, id),
      provider = await this.provider(attempt);
    const saved = await this.cipher.open(binding(attempt), secret);
    if (saved.kind !== "tokens") throw new OAuthError("invalidOAuthResponse");
    const tokens = oauthTokenValue(saved.tokens);
    await this.unchanged(attempt);
    const account = await provider.identity(tokens);
    const credential = await this.cipher.seal(
      { ownerId: owner, connectionId: attempt.connectionId, connectorId: attempt.providerId },
      { ...tokens, accountId: account.id },
    );
    // Another callback may have completed the same read-only verification while this one awaited the provider.
    const current = await this.attempts.status(owner, id);
    if (current.phase === "complete") return publicStatus(current);
    try {
      await this.attempts.complete(owner, id, async (value) => {
        await this.unchanged(value);
        return await this.owners.accept({
          attempt: value,
          account,
          grant: { expiresAt: tokens.expiresAt, scopes: tokens.scopes },
          credential,
        });
      });
    } catch (error) {
      if (!(
        error instanceof OAuthError &&
        error.code === "authorizationConsumed" &&
        (await this.attempts.status(owner, id)).phase === "complete"
      ))
        throw error;
    }
    return await this.status(owner, id);
  }
  async decline(owner: string, state: string) {
    const attempt = await this.attempts.lookup(owner, state);
    if (attempt.phase === "complete" || attempt.phase === "failed") return publicStatus(attempt);
    await this.attempts.abandon(owner, attempt.id);
    return await this.status(owner, attempt.id);
  }
}
