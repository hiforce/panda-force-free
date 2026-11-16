import type { CredentialEncryption } from "../credentials/ports.js";
import type { OAuthAttempts, OAuthAttempt } from "./attempts.js";
import type { OAuthConnectionOwner } from "./owner-port.js";
import { oauthTokenValue } from "./tokens.js";
import { createPkce } from "./pkce.js";
import { OAuthError } from "./errors.js";

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
export class OAuthConsent {
  constructor(
    private attempts: OAuthAttempts,
    private cipher: CredentialEncryption,
    private owners: OAuthConnectionOwner,
  ) {}
  private current(owner: string, connection: string) {
    const context = this.owners.current(owner, connection);
    if (context.ownerId !== owner || context.connectionId !== connection) throw new OAuthError("authorizationRejected");
    return context;
  }
  private unchanged(attempt: OAuthAttempt) {
    const target = this.current(attempt.ownerId, attempt.connectionId);
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
    const provider = await this.owners.provider(this.unchanged(attempt));
    this.unchanged(attempt);
    if (provider.configuration !== attempt.configuration) throw new OAuthError("authorizationRejected");
    return provider;
  }
  async start(owner: string, connection: string) {
    const context = this.current(owner, connection),
      attempt = this.attempts.reserve(context),
      keys = createPkce();
    try {
      const provider = await this.provider(attempt);
      const url = provider.authorize(keys.state, keys.challenge);
      const secret = await this.cipher.seal(binding(attempt), { kind: "pkce", verifier: keys.verifier });
      const prepared = this.attempts.prepare(owner, attempt.id, keys.state, secret, (value) => {
        this.unchanged(value);
      });
      return { ...publicStatus(prepared), url };
    } catch (error) {
      this.abandon(attempt);
      throw error;
    }
  }
  private abandon(attempt: OAuthAttempt) {
    try {
      this.attempts.abandon(attempt.ownerId, attempt.id);
    } catch (error) {
      if (!(error instanceof OAuthError && error.code === "authorizationExpired")) throw error;
    }
  }
  stateStatus(owner: string, state: string) {
    return publicStatus(this.attempts.lookup(owner, state));
  }
  status(owner: string, id: string) {
    return publicStatus(this.attempts.status(owner, id));
  }
  async callback(owner: string, state: string, code: string) {
    const previous = this.attempts.lookup(owner, state);
    if (previous.phase === "verifying") return this.verify(owner, previous.id);
    if (previous.phase !== "prepared") return publicStatus(previous);
    const { attempt, secret } = this.attempts.claim(owner, state, (value) => {
      this.unchanged(value);
    });
    try {
      const provider = await this.provider(attempt);
      const value = await this.cipher.open(binding(attempt), secret);
      if (value.kind !== "pkce" || typeof value.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier))
        throw new OAuthError("invalidOAuthInput");
      this.unchanged(attempt);
      const tokens = oauthTokenValue(await provider.exchange(code, value.verifier));
      const encrypted = await this.cipher.seal(binding(attempt), { kind: "tokens", tokens });
      this.attempts.stage(owner, attempt.id, encrypted, (value) => {
        this.unchanged(value);
      });
    } catch (error) {
      // Expiry may already have removed the record. Never replay a consumed authorization code.
      this.abandon(attempt);
      throw error;
    }
    return this.verify(owner, attempt.id);
  }
  async verify(owner: string, id: string) {
    const status = this.attempts.status(owner, id);
    if (status.phase === "complete") return publicStatus(status);
    const { attempt, secret } = this.attempts.pending(owner, id),
      provider = await this.provider(attempt);
    const saved = await this.cipher.open(binding(attempt), secret);
    if (saved.kind !== "tokens") throw new OAuthError("invalidOAuthResponse");
    const tokens = oauthTokenValue(saved.tokens);
    this.unchanged(attempt);
    const account = await provider.identity(tokens);
    const credential = await this.cipher.seal(
      { ownerId: owner, connectionId: attempt.connectionId, connectorId: attempt.providerId },
      { ...tokens, accountId: account.id },
    );
    // Another callback may have completed the same read-only verification while this one awaited the provider.
    const current = this.attempts.status(owner, id);
    if (current.phase === "complete") return publicStatus(current);
    try {
      this.attempts.complete(owner, id, (value) => {
        this.unchanged(value);
        return this.owners.accept({
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
        this.attempts.status(owner, id).phase === "complete"
      ))
        throw error;
    }
    return this.status(owner, id);
  }
  decline(owner: string, state: string) {
    const attempt = this.attempts.lookup(owner, state);
    if (attempt.phase === "complete" || attempt.phase === "failed") return publicStatus(attempt);
    this.attempts.abandon(owner, attempt.id);
    return this.status(owner, attempt.id);
  }
}
