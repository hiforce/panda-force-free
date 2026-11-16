import { accountAuthorizationView } from "./authorization-view.js";
import { randomUUID } from "node:crypto";
import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { CredentialEncryption, CredentialStore } from "../credentials/ports.js";
import type { OAuthConnectionOwner } from "../oauth/owner-port.js";
import type { OAuthAttemptTarget } from "../oauth/attempts.js";
import { OAuthError } from "../oauth/errors.js";
import { ConnectionError } from "../errors.js";
import { connectionId, connectionVersion } from "../validation.js";
import { accountInput, accountUpdate } from "./input.js";
import type { SocialAccountRepository, StoredSocialAccount } from "./repository.js";
import type { AccountTokenOwner, AccountTokenTarget } from "./token-port.js";
import type { AccountApplication, AccountProviderFactory } from "./ports.js";

const configurationBinding = (ownerId: string, connectionId: string) => ({
  ownerId,
  connectionId,
  connectorId: "oauth-app",
});
const tokenBinding = (ownerId: string, connection: SocialAccount) => ({
  ownerId,
  connectionId: connection.id,
  connectorId: connection.provider,
});
const publicApplication = (application: AccountApplication) => ({
  clientId: application.clientId,
  callbackUrl: application.callbackUrl,
  confidential: Boolean(application.clientSecret),
});

/** Owns account configuration and acceptance. Consent orchestration and platform transport are separate services. */
export class SocialAccountService implements OAuthConnectionOwner, AccountTokenOwner {
  constructor(
    private store: SocialAccountRepository,
    private secrets: CredentialStore,
    private cipher: CredentialEncryption,
    private providers: Record<SocialAccount["provider"], AccountProviderFactory>,
    private requireProject: (owner: string, project: string) => unknown,
  ) {}
  private owned(owner: string, id: string): StoredSocialAccount {
    const value = this.store.get(owner, connectionId(id));
    this.requireProject(owner, value.connection.projectId);
    return value;
  }
  detail(owner: string, id: string) {
    return accountAuthorizationView(owner, this.owned(owner, id).connection, this.secrets);
  }
  list(owner: string, project: string) {
    this.requireProject(owner, connectionId(project));
    return this.store.list(owner, project).map((account) => accountAuthorizationView(owner, account, this.secrets));
  }
  async create(owner: string, value: unknown) {
    const input = accountInput(value);
    this.requireProject(owner, input.projectId);
    const provider = this.providers[input.provider](input.application),
      configurationId = randomUUID();
    const secret = await this.cipher.seal(configurationBinding(owner, configurationId), { ...input.application });
    this.requireProject(owner, input.projectId);
    const now = Date.now();
    const created = this.store.create({
      ownerId: owner,
      configurationId,
      configuration: provider.configuration,
      secret,
      credentialRevision: 0,
      connection: {
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        provider: input.provider,
        version: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        application: publicApplication(input.application),
      },
    });
    return accountAuthorizationView(owner, created, this.secrets);
  }
  async update(owner: string, id: string, value: unknown) {
    const previous = this.owned(owner, id),
      input = accountUpdate(value);
    if (input.version !== previous.connection.version) throw new ConnectionError("conflict", 409);
    let configuration = previous.configuration,
      configurationId = previous.configurationId,
      secret = previous.secret;
    if (input.application) {
      configuration = this.providers[previous.connection.provider](input.application).configuration;
      configurationId = randomUUID();
      secret = await this.cipher.seal(configurationBinding(owner, configurationId), { ...input.application });
    }
    const invalidate = configuration !== previous.configuration || !input.enabled;
    // Preserve monotonically increasing revisions when removing tokens so stale reads cannot see an ABA revision.
    const erased =
      invalidate && previous.credentialRevision
        ? await this.cipher.seal(tokenBinding(owner, previous.connection), { kind: "disconnected" })
        : null;
    this.owned(owner, id);
    const updated = this.store.change(owner, id, input.version, (current) => {
      const credentialRevision = erased
        ? this.secrets.put(tokenBinding(owner, current.connection), current.credentialRevision, erased).revision
        : current.credentialRevision;
      const connection = {
        ...current.connection,
        name: input.name,
        enabled: input.enabled,
        ...(input.application ? { application: publicApplication(input.application) } : {}),
      };
      if (invalidate) delete connection.grant;
      return { ...current, configuration, configurationId, secret, credentialRevision, connection };
    });
    return accountAuthorizationView(owner, updated, this.secrets);
  }
  /** Revoke local usage and erase saved tokens while retaining the immutable account association. */
  disconnect(owner: string, id: string, version: number) {
    const current = this.detail(owner, id);
    return this.update(owner, id, { version: connectionVersion(version), name: current.name, enabled: false });
  }
  current(owner: string, id: string): OAuthAttemptTarget {
    const value = this.owned(owner, id),
      connection = value.connection;
    if (!connection.enabled) throw new OAuthError("authorizationRejected");
    return {
      ownerId: owner,
      projectId: connection.projectId,
      connectionId: id,
      connectionVersion: connection.version,
      providerId: connection.provider,
      configuration: value.configuration,
    };
  }
  private checkTarget(target: OAuthAttemptTarget) {
    const current = this.current(target.ownerId, target.connectionId);
    if (
      current.projectId !== target.projectId ||
      current.connectionVersion !== target.connectionVersion ||
      current.providerId !== target.providerId ||
      current.configuration !== target.configuration
    )
      throw new OAuthError("authorizationRejected");
  }
  async provider(target: OAuthAttemptTarget) {
    const value = this.owned(target.ownerId, target.connectionId);
    this.checkTarget(target);
    const saved = await this.cipher.open(configurationBinding(target.ownerId, value.configurationId), value.secret);
    const application = accountInput({
      id: target.connectionId,
      projectId: target.projectId,
      name: value.connection.name,
      provider: value.connection.provider,
      application: saved,
    }).application;
    const provider = this.providers[value.connection.provider](application);
    this.checkTarget(target);
    if (provider.configuration !== target.configuration) throw new OAuthError("authorizationRejected");
    return provider;
  }
  accessTarget(owner: string, id: string): AccountTokenTarget {
    const target = this.current(owner, id),
      value = this.owned(owner, id),
      connection = value.connection;
    if (!connection.account || !connection.grant || connection.grant.credentialRevision !== value.credentialRevision)
      throw new OAuthError("authorizationRejected");
    return {
      ...target,
      accountId: connection.account.id,
      credentialRevision: value.credentialRevision,
      scopes: [...connection.grant.scopes],
    };
  }
  rotate(...[target, lease, secret, grant]: Parameters<AccountTokenOwner["rotate"]>) {
    this.accessTarget(target.ownerId, target.connectionId);
    this.store.rotate(target, grant, () =>
      this.secrets.put(
        { ownerId: target.ownerId, connectionId: target.connectionId, connectorId: target.providerId },
        target.credentialRevision,
        secret,
        lease,
      ),
    );
  }
  accept(input: Parameters<OAuthConnectionOwner["accept"]>[0]) {
    const { attempt, account, grant, credential } = input;
    this.current(attempt.ownerId, attempt.connectionId);
    return this.store.change(attempt.ownerId, attempt.connectionId, attempt.connectionVersion, (current) => {
      if (
        current.configuration !== attempt.configuration ||
        current.connection.provider !== attempt.providerId ||
        current.connection.projectId !== attempt.projectId
      )
        throw new OAuthError("authorizationRejected");
      if (current.connection.account && current.connection.account.id !== account.id)
        throw new ConnectionError("targetChanged", 409);
      const metadata = this.secrets.put(
        tokenBinding(attempt.ownerId, current.connection),
        current.credentialRevision,
        credential,
      );
      return {
        ...current,
        credentialRevision: metadata.revision,
        connection: {
          ...current.connection,
          account: { ...account },
          grant: { expiresAt: grant.expiresAt, scopes: [...grant.scopes], credentialRevision: metadata.revision },
        },
      };
    });
  }
}
