import { SocialContinuationService } from "../social/continuation.js";
import { SocialRecoveryService } from "../social/recovery.js";
import { XRecoveryClient } from "../adapters/x/recovery-client.js";
import { DeliveryError } from "../errors.js";
import type { Database } from "bun:sqlite";
import type { SocialWorkflowKind } from "../../../shared/delivery/social.js";
import type { SocialAccounts, SocialSources } from "../social/ports.js";
import { WorkflowRepository } from "../storage/workflows.js";
import { WorkflowWorker } from "../workflows/worker.js";
import { SocialPublicationService } from "../social/service.js";
import { socialKinds } from "../social/payload.js";
import { XPublicationWorkflow } from "../adapters/x/workflow.js";
import { XPublicationClient } from "../adapters/x/client.js";
import { XPublicationHttp, type XJsonTransport } from "../adapters/x/http.js";
import { XMediaClient } from "../adapters/x/media-client.js";
import { XPublicationMedia } from "../adapters/x/media-workflow.js";

export function createSocialPublicationFeature(options: {
  db: Database;
  sources: SocialSources;
  accounts: SocialAccounts;
  transport?: XJsonTransport;
  now?: () => number;
}) {
  const now = options.now || Date.now,
    transport = options.transport || new XPublicationHttp();
  const stores = new Map(socialKinds.map((kind) => [kind, new WorkflowRepository(options.db, kind, now)]));
  const workers = new Map<SocialWorkflowKind, WorkflowWorker>();
  const getStore = (kind: unknown) => {
    const store = stores.get(kind as SocialWorkflowKind);
    if (!store) throw new DeliveryError("invalidInput");
    return store;
  };
  const recovery = new SocialRecoveryService(
    options.sources,
    options.accounts,
    getStore,
    new XRecoveryClient(transport, now),
  );
  const continuation = new SocialContinuationService(options.sources, options.accounts, getStore);
  const service = new SocialPublicationService(
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
    workers.set(kind, new WorkflowWorker(store, handler, (code) => console.warn("[social-publication]", code)));
  for (const worker of workers.values()) worker.wake();
  return {
    service,
    recovery,
    continuation,
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
