import type { Database } from "bun:sqlite";
import type { RouteContext } from "../../http/router.js";
import { createPublicationConnections } from "../../connections/integration/feature.js";
import type { PublicationSources } from "../ports.js";
import { PublicationRepository } from "../repository.js";
import { PublicationService } from "../service.js";
import { PublicationWorker } from "../worker.js";
import { LocalSiteDelivery } from "../adapters/local-site.js";
import { SftpSiteDelivery } from "../adapters/sftp-site.js";
import { DeliveryError } from "../errors.js";
import type { RemoteSites } from "../../../shared/connections/remote-files.js";
import { accountRoutes } from "../../connections/integration/account-routes.js";
import { publicationRoutes } from "./routes.js";
import { createSocialPublicationFeature } from "./social-feature.js";
import { socialAccounts } from "./social-accounts.js";
import { socialPublicationRoutes } from "./social-routes.js";
import type { SocialSources } from "../social/ports.js";

export function createSitePublicationFeature(options: {
  db: Database;
  stateRoot: string;
  requireProject: (id: string) => unknown;
  sourceRoots: () => string[];
  sources: PublicationSources;
  socialSources: SocialSources;
  owner: (context: RouteContext) => string;
  env?: NodeJS.ProcessEnv;
  remoteSites?: RemoteSites;
}) {
  const { accounts, accountTokens, consent, connections, credentials, targets, sites, trust } =
    createPublicationConnections(options);
  const social = createSocialPublicationFeature({
    db: options.db,
    sources: options.socialSources,
    accounts: socialAccounts(accounts, accountTokens),
  });
  const store = new PublicationRepository(options.db);
  let worker: PublicationWorker;
  const service = new PublicationService(options.sources, connections, store, () => worker.wake());
  const adapters = {
    "local-site": () => new LocalSiteDelivery(targets),
    "sftp-site": (owner: string, plan: Parameters<PublicationService["assertExecutable"]>[1]) =>
      new SftpSiteDelivery(async () => {
        const current = connections.owned(owner, plan.connectionId);
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
  worker = new PublicationWorker(
    store,
    (owner, plan) => adapters[plan.connection.connector](owner, plan),
    (owner, plan, checkOnly) => service.assertExecutable(owner, plan, checkOnly),
    (code) => console.warn("[publication]", code),
  );
  worker.wake();
  return {
    connections,
    service,
    routes: [
      ...publicationRoutes(connections, credentials, trust, service, options.owner),
      ...accountRoutes(accounts, consent, options.owner),
      ...socialPublicationRoutes(social.service, options.owner),
    ],
    stop: async () => {
      await Promise.all([worker.stop(), social.stop()]);
    },
  };
}
