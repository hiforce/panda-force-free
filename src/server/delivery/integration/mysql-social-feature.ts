import type { AsyncStore } from "../../../shared/async-store.js";
import type { SocialWorkflowKind } from "../../../shared/delivery/social.js";
import { XPublicationClient } from "../adapters/x/client.js";
import { XPublicationHttp, type XJsonTransport } from "../adapters/x/http.js";
import { XMediaClient } from "../adapters/x/media-client.js";
import { XPublicationMedia } from "../adapters/x/media-workflow.js";
import { XRecoveryClient } from "../adapters/x/recovery-client.js";
import { XPublicationWorkflow } from "../adapters/x/workflow.js";
import { DeliveryError } from "../errors.js";
import type { AsyncSocialSources } from "../social/async-ports.js";
import { MySQLSocialContinuationService } from "../social/mysql-continuation.js";
import { MySQLSocialRecoveryService } from "../social/mysql-recovery.js";
import { MySQLSocialPublicationService } from "../social/mysql-service.js";
import { socialKinds } from "../social/payload.js";
import type { SocialAccounts } from "../social/ports.js";
import { MySQLWorkflowWorker } from "../workflows/mysql-worker.js";
import type { PublicationPersistence } from "./mysql-persistence.js";
/** Native workflows start only after the caller verifies imports and explicitly starts workers. */
export function createMySQLSocialPublicationFeature(options: {
  storage: PublicationPersistence;
  sources: AsyncSocialSources;
  accounts: AsyncStore<SocialAccounts>;
  transport?: XJsonTransport;
  now?: () => number;
}) {
  const now = options.now ?? Date.now,
    transport = options.transport ?? new XPublicationHttp(),
    stores = new Map(socialKinds.map((kind) => [kind, options.storage.workflow(kind)])),
    workers = new Map<SocialWorkflowKind, MySQLWorkflowWorker>();
  const getStore = (kind: unknown) => {
    const store = stores.get(kind as SocialWorkflowKind);
    if (!store) throw new DeliveryError("invalidInput");
    return store;
  };
  const recovery = new MySQLSocialRecoveryService(
      options.sources,
      options.accounts,
      getStore,
      new XRecoveryClient(transport, now),
    ),
    continuation = new MySQLSocialContinuationService(options.sources, options.accounts, getStore),
    service = new MySQLSocialPublicationService(
      options.sources,
      options.accounts,
      stores,
      (kind) => workers.get(kind)?.wake(),
      now,
      recovery,
      continuation,
    );
  const handler = new XPublicationWorkflow(
    options.accounts,
    new XPublicationClient(transport, now),
    (owner, plan) => service.authorizeExecution(owner, plan),
    options.sources,
    new XPublicationMedia(options.sources, options.accounts, new XMediaClient(transport, now), now),
    now,
  );
  for (const [kind, store] of stores)
    workers.set(kind, new MySQLWorkflowWorker(store, handler, (code) => console.warn("[social-publication]", code)));
  return {
    service,
    recovery,
    continuation,
    start() {
      for (const worker of workers.values()) worker.start();
    },
    wake() {
      for (const worker of workers.values()) worker.wake();
    },
    async idle() {
      await Promise.all([...workers.values()].map((worker) => worker.idle()));
    },
    async stop() {
      await Promise.all([...workers.values()].map((worker) => worker.stop()));
    },
  };
}
