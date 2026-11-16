import { randomUUID } from "node:crypto";
import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { AsyncPublicationStore } from "../async-ports.js";
import type { CredentialEncryption, CredentialStore } from "../credentials/ports.js";
import { ConnectionError } from "../errors.js";
import { OAuthError } from "../oauth/errors.js";
import type { OAuthAttemptTarget } from "../oauth/mysql-attempts.js";
import type { OAuthConnectionOwner } from "../oauth/owner-port.js";
import type { ConnectionPersistence } from "../persistence.js";
import { connectionId, connectionVersion } from "../validation.js";
import { accountInput, accountUpdate } from "./input.js";
import { mysqlAccountAuthorizationView } from "./mysql-authorization-view.js";
import type { StoredSocialAccount } from "./mysql-repository.js";
import type { AccountApplication, AccountProviderFactory } from "./ports.js";
import type { AccountTokenOwner, AccountTokenTarget } from "./token-port.js";
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
export class MySQLSocialAccountService {
  constructor(
    private store: ConnectionPersistence["accounts"],
    private secrets: AsyncPublicationStore<CredentialStore>,
    private cipher: CredentialEncryption,
    private providers: Record<SocialAccount["provider"], AccountProviderFactory>,
    private requireProject: (owner: string, project: string) => unknown,
    private transaction: ConnectionPersistence["transaction"],
  ) {}
  private async owned(owner: string, id: string): Promise<StoredSocialAccount> {
    const value = await this.store.get(owner, connectionId(id));
    await this.requireProject(owner, value.connection.projectId);
    return value;
  }
  async detail(owner: string, id: string) {
    return await mysqlAccountAuthorizationView(owner, (await this.owned(owner, id)).connection, this.secrets);
  }
  async list(owner: string, project: string) {
    await this.requireProject(owner, connectionId(project));
    return await Promise.all(
      (await this.store.list(owner, project)).map(
        async (account) => await mysqlAccountAuthorizationView(owner, account, this.secrets),
      ),
    );
  }
  async create(owner: string, value: unknown) {
    const input = accountInput(value);
    await this.requireProject(owner, input.projectId);
    const provider = this.providers[input.provider](input.application),
      configurationId = randomUUID();
    const secret = await this.cipher.seal(configurationBinding(owner, configurationId), { ...input.application });
    await this.requireProject(owner, input.projectId);
    const now = Date.now();
    const created = await this.transaction(async () => {
      await this.requireProject(owner, input.projectId);
      return await this.store.create({
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
    });
    return await mysqlAccountAuthorizationView(owner, created, this.secrets);
  }
  async update(owner: string, id: string, value: unknown) {
    const previous = await this.owned(owner, id),
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
    await this.owned(owner, id);
    const updated = await this.store.change(owner, id, input.version, async (current) => {
      await this.owned(owner, id);
      const credentialRevision = erased
        ? (await this.secrets.put(tokenBinding(owner, current.connection), current.credentialRevision, erased)).revision
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
    return await mysqlAccountAuthorizationView(owner, updated, this.secrets);
  }
  /** Revoke local usage and erase saved tokens while retaining the immutable account association. */
  async disconnect(owner: string, id: string, version: number) {
    const current = await this.detail(owner, id);
    return await this.update(owner, id, { version: connectionVersion(version), name: current.name, enabled: false });
  }
  async current(owner: string, id: string): Promise<OAuthAttemptTarget> {
    const value = await this.owned(owner, id),
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
  private async checkTarget(target: OAuthAttemptTarget) {
    const current = await this.current(target.ownerId, target.connectionId);
    if (
      current.projectId !== target.projectId ||
      current.connectionVersion !== target.connectionVersion ||
      current.providerId !== target.providerId ||
      current.configuration !== target.configuration
    )
      throw new OAuthError("authorizationRejected");
  }
  async provider(target: OAuthAttemptTarget) {
    const value = await this.owned(target.ownerId, target.connectionId);
    await this.checkTarget(target);
    const saved = await this.cipher.open(configurationBinding(target.ownerId, value.configurationId), value.secret);
    const application = accountInput({
      id: target.connectionId,
      projectId: target.projectId,
      name: value.connection.name,
      provider: value.connection.provider,
      application: saved,
    }).application;
    const provider = this.providers[value.connection.provider](application);
    await this.checkTarget(target);
    if (provider.configuration !== target.configuration) throw new OAuthError("authorizationRejected");
    return provider;
  }
  async accessTarget(owner: string, id: string): Promise<AccountTokenTarget> {
    const target = await this.current(owner, id),
      value = await this.owned(owner, id),
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
  async rotate(...[target, lease, secret, grant]: Parameters<AsyncPublicationStore<AccountTokenOwner>["rotate"]>) {
    await this.accessTarget(target.ownerId, target.connectionId);
    await this.store.rotate(target, grant, async () => {
      await this.accessTarget(target.ownerId, target.connectionId);
      return this.secrets.put(
        { ownerId: target.ownerId, connectionId: target.connectionId, connectorId: target.providerId },
        target.credentialRevision,
        secret,
        lease,
      );
    });
  }
  async accept(input: Parameters<AsyncPublicationStore<OAuthConnectionOwner>["accept"]>[0]) {
    const { attempt, account, grant, credential } = input;
    await this.current(attempt.ownerId, attempt.connectionId);
    return await this.store.change(
      attempt.ownerId,
      attempt.connectionId,
      attempt.connectionVersion,
      async (current) => {
        await this.current(attempt.ownerId, attempt.connectionId);
        if (
          current.configuration !== attempt.configuration ||
          current.connection.provider !== attempt.providerId ||
          current.connection.projectId !== attempt.projectId
        )
          throw new OAuthError("authorizationRejected");
        if (current.connection.account && current.connection.account.id !== account.id)
          throw new ConnectionError("targetChanged", 409);
        const metadata = await this.secrets.put(
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
      },
    );
  }
}
