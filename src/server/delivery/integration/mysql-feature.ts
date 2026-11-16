import type { RemoteSites } from "../../../shared/connections/remote-files.js";
import type { AccountProviderFactory } from "../../connections/accounts/ports.js";
import { accountRoutes } from "../../connections/integration/account-routes.js";
import { createMySQLPublicationConnections } from "../../connections/integration/mysql-feature.js";
import type { RouteContext } from "../../http/router.js";
import { LocalSiteDelivery } from "../adapters/local-site.js";
import { SftpSiteDelivery } from "../adapters/sftp-site.js";
import type { XJsonTransport } from "../adapters/x/http.js";
import { DeliveryError } from "../errors.js";
import { MySQLPublicationService } from "../mysql-service.js";
import { MySQLPublicationWorker } from "../mysql-worker.js";
import type { PublicationSources } from "../ports.js";
import type { AsyncSocialSources } from "../social/async-ports.js";
import type { PublicationPersistence } from "./mysql-persistence.js";
import { mysqlSocialAccounts } from "./mysql-social-accounts.js";
import { createMySQLSocialPublicationFeature } from "./mysql-social-feature.js";
import { publicationRoutes } from "./routes.js";
import { socialPublicationRoutes } from "./social-routes.js";
/** An explicit native backend opens no business SQLite connection. The caller verifies schema/data before start(). */
export async function createMySQLSitePublicationFeature(options: {
  storage: PublicationPersistence;
  stateRoot: string;
  requireProject: (id: string) => unknown;
  sourceRoots: () => string[] | Promise<string[]>;
  sources: PublicationSources;
  socialSources: AsyncSocialSources;
  owner: (context: RouteContext) => string;
  env?: NodeJS.ProcessEnv;
  remoteSites?: RemoteSites;
  providers?: Record<"x", AccountProviderFactory>;
  transport?: XJsonTransport;
}) {
  const { accounts, accountTokens, consent, connections, credentials, targets, sites, trust } =
    await createMySQLPublicationConnections({ ...options, storage: options.storage.connections });
  const social = createMySQLSocialPublicationFeature({
    storage: options.storage,
    sources: options.socialSources,
    accounts: mysqlSocialAccounts(accounts, accountTokens),
    transport: options.transport,
  });
  let worker: MySQLPublicationWorker;
  const service = new MySQLPublicationService(options.sources, connections, options.storage.site, () => worker.wake());
  const adapters = {
    "local-site": () => new LocalSiteDelivery(targets),
    "sftp-site": (owner: string, plan: Parameters<MySQLPublicationService["assertExecutable"]>[1]) =>
      new SftpSiteDelivery(async () => {
        const current = await connections.owned(owner, plan.connectionId);
        if (current.connection.connector !== "sftp-site" || current.targetPath + "/current" !== plan.servedPath)
          throw new DeliveryError("conflict", 409);
        let credential: Record<string, unknown>;
        try {
          credential = await credentials.read(owner, current.connection);
        } catch {
          throw new DeliveryError("remoteCredentialUnavailable", 409);
        }
        return sites.connect(current.connection, credential);
      }),
  };
  worker = new MySQLPublicationWorker(
    options.storage.site,
    (owner, plan) => adapters[plan.connection.connector](owner, plan),
    (owner, plan, checkOnly) => service.assertExecutable(owner, plan, checkOnly),
    (code) => console.warn("[publication]", code),
  );
  return {
    connections,
    service,
    accounts,
    consent,
    credentials,
    trust,
    routes: [
      ...publicationRoutes(connections, credentials, trust, service, options.owner),
      ...accountRoutes(accounts, consent, options.owner),
      ...socialPublicationRoutes(social.service, options.owner),
    ],
    start() {
      worker.start();
      social.start();
    },
    async idle() {
      await Promise.all([worker.idle(), social.idle()]);
    },
    async stop() {
      await Promise.all([worker.stop(), social.stop()]);
    },
  };
}
