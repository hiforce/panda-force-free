import { dirname, join } from "node:path";
import { mapMetadata } from "../../../shared/async-value.js";
import type { RemoteSites } from "../../../shared/connections/remote-files.js";
import { SftpFileFactory } from "../../remote-files/sftp.js";
import { SftpSites } from "../../remote-files/site.js";
import { MySQLSocialAccountService } from "../accounts/mysql-service.js";
import { MySQLAccountTokens } from "../accounts/mysql-tokens.js";
import type { AccountProviderFactory } from "../accounts/ports.js";
import { localConnector } from "../adapters/local-connector.js";
import { LocalTargets } from "../adapters/local-targets.js";
import { MySQLSftpHostTrust } from "../adapters/mysql-sftp-trust.js";
import { sftpConnector } from "../adapters/sftp-connector.js";
import { XOAuthProvider } from "../adapters/x/oauth.js";
import { CredentialCipher } from "../credentials/cipher.js";
import { MySQLConnectionSecretService } from "../mysql-secret-service.js";
import { MySQLConnectionService } from "../mysql-service.js";
import { OAuthHttp } from "../oauth/http.js";
import { MySQLOAuthConsent } from "../oauth/mysql-service.js";
import type { ConnectionPersistence } from "../persistence.js";
import { ConnectionRegistry } from "../registry.js";
import { publicationRoots, sftpLimits } from "./config.js";
import { mysqlConnectionKey } from "./mysql-key-provider.js";
/** Explicit native composition retains the configured filesystem/remote owners and starts no platform operation. */
export async function createMySQLPublicationConnections(options: {
  storage: ConnectionPersistence;
  stateRoot: string;
  sourceRoots: () => string[] | Promise<string[]>;
  requireProject: (id: string) => unknown;
  env?: NodeJS.ProcessEnv;
  remoteSites?: RemoteSites;
  providers?: Record<"x", AccountProviderFactory>;
}) {
  const storage = options.storage,
    key = mysqlConnectionKey(options.stateRoot, storage, options.env);
  await key.ready();
  const cipher = new CredentialCipher(key.provider),
    accounts = new MySQLSocialAccountService(
      storage.accounts,
      storage.secrets,
      cipher,
      options.providers ?? { x: (config) => new XOAuthProvider(config, new OAuthHttp()) },
      (_owner, project) => options.requireProject(project),
      storage.transaction,
    ),
    consent = new MySQLOAuthConsent(storage.attempts, cipher, accounts),
    accountTokens = new MySQLAccountTokens(accounts, storage.secrets, cipher);
  const targets = new LocalTargets(publicationRoots(options.stateRoot, options.env), () =>
      mapMetadata(options.sourceRoots(), (roots) => [
        ...["config", "data", "logs", "uploads", "plugins", "cache"].map((name) => join(options.stateRoot, name)),
        dirname(key.path),
        ...roots,
      ]),
    ),
    sites = options.remoteSites ?? new SftpSites(new SftpFileFactory(sftpLimits(options.env)));
  let credentials: MySQLConnectionSecretService;
  const registry = new ConnectionRegistry([
      localConnector(targets),
      sftpConnector(sites, { read: (owner, connection) => credentials.read(owner, connection) }),
    ]),
    connections = new MySQLConnectionService(storage.records, registry, options.requireProject, storage.transaction);
  credentials = new MySQLConnectionSecretService(connections, storage.records, registry, storage.secrets, cipher);
  return {
    accounts,
    accountTokens,
    consent,
    connections,
    credentials,
    targets,
    sites,
    trust: new MySQLSftpHostTrust(connections, storage.records, storage.transaction),
  };
}
