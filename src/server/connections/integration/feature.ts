import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RemoteSites } from "../../../shared/connections/remote-files.js";
import { SftpFileFactory } from "../../remote-files/sftp.js";
import { SftpSites } from "../../remote-files/site.js";
import { LocalTargets } from "../adapters/local-targets.js";
import { localConnector } from "../adapters/local-connector.js";
import { sftpConnector } from "../adapters/sftp-connector.js";
import { SftpHostTrust } from "../adapters/sftp-trust.js";
import { ConnectionRegistry } from "../registry.js";
import { ConnectionRepository } from "../repository.js";
import { ConnectionService } from "../service.js";
import { ConnectionSecretService } from "../secret-service.js";
import { CredentialRepository } from "../credentials/repository.js";
import { CredentialCipher } from "../credentials/cipher.js";
import { publicationRoots, sftpLimits } from "./config.js";
import { connectionKey } from "./key-provider.js";
import { SocialAccountRepository } from "../accounts/repository.js";
import { AccountTokens } from "../accounts/tokens.js";
import { SocialAccountService } from "../accounts/service.js";
import { OAuthAttempts } from "../oauth/attempts.js";
import { OAuthConsent } from "../oauth/service.js";
import { OAuthHttp } from "../oauth/http.js";
import { XOAuthProvider } from "../adapters/x/oauth.js";

export function createPublicationConnections(options: {
  db: Database;
  stateRoot: string;
  sourceRoots: () => string[];
  requireProject: (id: string) => unknown;
  env?: NodeJS.ProcessEnv;
  remoteSites?: RemoteSites;
}) {
  const secrets = new CredentialRepository(options.db),
    accountRecords = new SocialAccountRepository(options.db),
    attempts = new OAuthAttempts(options.db),
    key = connectionKey(
      options.stateRoot,
      { count: () => secrets.count() + accountRecords.encryptedCount() + attempts.encryptedCount() },
      options.env,
    ),
    cipher = new CredentialCipher(key.provider);
  const accounts = new SocialAccountService(
    accountRecords,
    secrets,
    cipher,
    { x: (config) => new XOAuthProvider(config, new OAuthHttp()) },
    (_owner, project) => options.requireProject(project),
  );
  const consent = new OAuthConsent(attempts, cipher, accounts);
  const accountTokens = new AccountTokens(accounts, secrets, cipher);
  const targets = new LocalTargets(publicationRoots(options.stateRoot, options.env), () => [
    ...["config", "data", "logs", "uploads", "plugins", "cache"].map((name) => join(options.stateRoot, name)),
    dirname(key.path),
    ...options.sourceRoots(),
  ]);
  const sites = options.remoteSites || new SftpSites(new SftpFileFactory(sftpLimits(options.env)));
  let credentials: ConnectionSecretService;
  const registry = new ConnectionRegistry([
    localConnector(targets),
    sftpConnector(sites, {
      read: (owner, connection) => credentials.read(owner, connection),
    }),
  ]);
  const repository = new ConnectionRepository(options.db);
  const connections = new ConnectionService(repository, registry, options.requireProject);
  credentials = new ConnectionSecretService(connections, repository, registry, secrets, cipher);
  return {
    accounts,
    accountTokens,
    consent,
    connections,
    credentials,
    targets,
    sites,
    trust: new SftpHostTrust(connections, repository),
  };
}
