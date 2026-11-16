import type { SocialContinuationService } from "./continuation.js";
import { currentBoundTarget } from "./target-binding.js";
import type { SocialRecoveryService } from "./recovery.js";
import type { JsonValue, WorkflowPlan } from "../../../shared/delivery/workflow.js";
import type { ArticlePublishPayload, SocialPayload, SocialWorkflowKind } from "../../../shared/delivery/social.js";
import type { WorkflowRepository } from "../storage/workflows.js";
import type { SocialSources, SocialAccounts } from "./ports.js";
import { socialKinds, socialPayload } from "./payload.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";

const uuid = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw new DeliveryError("invalidInput");
  return value;
};
export class SocialPublicationService {
  constructor(
    private sources: SocialSources,
    private accounts: SocialAccounts,
    private stores: ReadonlyMap<SocialWorkflowKind, WorkflowRepository>,
    private wake: (kind: SocialWorkflowKind) => void,
    private now = Date.now,
    readonly recovery?: SocialRecoveryService,
    readonly continuation?: SocialContinuationService,
  ) {}
  private store(kind: unknown) {
    if (typeof kind !== "string" || !socialKinds.includes(kind as SocialWorkflowKind))
      throw new DeliveryError("invalidInput");
    const store = this.stores.get(kind as SocialWorkflowKind);
    if (!store) throw new DeliveryError("unavailable", 503);
    return store;
  }
  async assert(owner: string, plan: WorkflowPlan) {
    const payload = socialPayload(plan);
    const sourceGuard = await this.sources.authorize(owner, payload.source, plan.projectId, plan.spaceId);
    const guard = () => {
      sourceGuard();
      this.accounts.assert(owner, payload.target, payload.media?.length ? "media" : undefined);
      if ("draftJobId" in payload) {
        const draft = this.store("x-article-draft").owned(owner, payload.draftJobId);
        if (
          draft.phase !== "completed" ||
          !draft.receipt ||
          Array.isArray(draft.receipt) ||
          typeof draft.receipt !== "object" ||
          draft.receipt.articleId !== payload.articleId ||
          draft.receipt.accountId !== payload.target.accountId ||
          draft.plan.sourceProjectId !== plan.sourceProjectId ||
          draft.plan.spaceId !== plan.spaceId
        )
          throw new DeliveryError("draftRequired", 409);
      }
    };
    guard();
    return guard;
  }
  async authorizeExecution(owner: string, plan: WorkflowPlan) {
    const sourceGuard = await this.assert(owner, plan);
    const guard = () => {
      if (plan.expiresAt <= this.now()) throw new DeliveryError("planExpired", 409);
      const record = this.store(plan.kind).owned(owner, plan.id),
        confirmation = record.confirmations.at(-1);
      const details = confirmation?.details;
      if (
        !confirmation ||
        confirmation.actor !== owner ||
        confirmation.fingerprint !== plan.fingerprint ||
        !details ||
        typeof details !== "object" ||
        Array.isArray(details) ||
        details.acceptPlatformCosts !== true ||
        details.acceptPlatformEligibility !== true ||
        details.action !== plan.kind
      )
        throw new DeliveryError("publicationConfirmationRequired", 409);
      sourceGuard();
    };
    guard();
    return guard;
  }
  async list(owner: string, spaceId: string, projectId?: string) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(spaceId) ||
      (projectId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId))
    )
      throw new DeliveryError("invalidInput");
    const guard = await this.sources.space(owner, spaceId, projectId);
    guard();
    return socialKinds
      .flatMap((kind) => this.store(kind).list(owner, spaceId, projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }
  async context(owner: string, variantId: string) {
    const captured = await this.sources.capture(owner, uuid(variantId));
    return {
      projectId: captured.projectId,
      spaceId: captured.spaceId,
      ...(captured.source.projectId === undefined ? {} : { sourceProjectId: captured.source.projectId }),
    };
  }
  async detail(owner: string, kind: unknown, id: string) {
    const record = this.store(kind).owned(owner, uuid(id));
    socialPayload(record.plan);
    const guard = await this.sources.space(owner, record.plan.spaceId, record.plan.sourceProjectId);
    guard();
    return this.store(kind).owned(owner, id);
  }
  async prepare(owner: string, input: Record<string, unknown>) {
    if (Object.keys(input).some((key) => !["id", "variantId", "connectionId"].includes(key)))
      throw new DeliveryError("invalidInput");
    const id = uuid(input.id),
      connectionId = uuid(input.connectionId),
      variantId = uuid(input.variantId);
    const captured = await this.sources.capture(owner, variantId),
      target = this.accounts.target(owner, connectionId);
    if (target.projectId !== captured.projectId) throw new DeliveryError("notFound", 404);
    const payload: SocialPayload = {
      adapterVersion: 2,
      source: captured.source,
      target,
      content: captured.content,
      media: captured.media,
      platformCosts: "unknown",
    };
    const kind = captured.content.format === "x-article" ? "x-article-draft" : "x-post";
    const store = this.store(kind);
    const sourceGuard = await this.sources.authorize(owner, captured.source, captured.projectId, captured.spaceId);
    this.accounts.assert(owner, target, captured.media.length ? "media" : undefined);
    // Semantic identity survives browser retries and a newly generated request UUID.
    const identity = digest(
      JSON.stringify({
        spaceId: captured.spaceId,
        revision: captured.source.revisionId,
        account: target.accountId,
        connectionId,
        format: captured.content.format,
        ...(captured.source.projectId === undefined ? {} : { sourceProjectId: captured.source.projectId }),
      }),
    );
    return store.transaction(() => {
      sourceGuard();
      this.accounts.assert(owner, target, captured.media.length ? "media" : undefined);
      return store.prepare(owner, identity, {
        id,
        projectId: captured.projectId,
        spaceId: captured.spaceId,
        connectionId,
        payload: payload as unknown as JsonValue,
        ...(captured.source.projectId === undefined ? {} : { sourceProjectId: captured.source.projectId }),
      });
    });
  }
  async prepareArticlePublish(owner: string, input: Record<string, unknown>) {
    if (Object.keys(input).some((key) => !["id", "draftId"].includes(key))) throw new DeliveryError("invalidInput");
    const requestId = uuid(input.id),
      draft = await this.detail(owner, "x-article-draft", uuid(input.draftId));
    const original = socialPayload(draft.plan),
      currentTarget = currentBoundTarget(this.accounts, owner, original.target);
    const sourceGuard = await this.sources.authorize(owner, original.source, draft.plan.projectId, draft.plan.spaceId);
    this.accounts.assert(owner, currentTarget, original.media?.length ? "media" : undefined);
    if (
      draft.phase !== "completed" ||
      !draft.receipt ||
      typeof draft.receipt !== "object" ||
      Array.isArray(draft.receipt) ||
      typeof draft.receipt.articleId !== "string"
    )
      throw new DeliveryError("draftRequired", 409);
    if (!("content" in original) || original.content.format !== "x-article")
      throw new DeliveryError("draftRequired", 409);
    const payload: ArticlePublishPayload = {
      adapterVersion: original.adapterVersion,
      source: original.source,
      target: currentTarget,
      draftJobId: draft.plan.id,
      articleId: draft.receipt.articleId,
      draft: original.content.draft,
      ...(original.media ? { media: original.media } : {}),
      platformCosts: "unknown",
    };
    const store = this.store("x-article-publish");
    const record = store.transaction(() => {
      sourceGuard();
      this.accounts.assert(owner, currentTarget, original.media?.length ? "media" : undefined);
      return store.prepare(
        owner,
        digest(
          JSON.stringify({ draftId: draft.plan.id, articleId: payload.articleId, accountId: payload.target.accountId }),
        ),
        {
          id: requestId,
          projectId: draft.plan.projectId,
          spaceId: draft.plan.spaceId,
          connectionId: draft.plan.connectionId,
          payload: payload as unknown as JsonValue,
          ...(draft.plan.sourceProjectId === undefined ? {} : { sourceProjectId: draft.plan.sourceProjectId }),
        },
      );
    });
    sourceGuard();
    (await this.assert(owner, record.plan))();
    return record;
  }
  async submit(owner: string, input: Record<string, unknown>) {
    input = { ...input };
    if (
      Object.keys(input).some(
        (key) =>
          !["id", "kind", "fingerprint", "acceptPlatformCosts", "acceptPlatformEligibility", "resume"].includes(key),
      ) ||
      input.acceptPlatformCosts !== true ||
      input.acceptPlatformEligibility !== true ||
      typeof input.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
      (input.resume !== undefined && typeof input.resume !== "boolean")
    )
      throw new DeliveryError("publicationConfirmationRequired", 409);
    const store = this.store(input.kind);
    await this.detail(owner, input.kind, uuid(input.id));
    const { record: current, ready } = store.queueState(
      owner,
      uuid(input.id),
      input.fingerprint,
      input.resume === true,
    );
    if (!ready) return current;
    const authorization = await this.assert(owner, current.plan);
    const result = store.queue(owner, uuid(input.id), input.fingerprint, () => authorization(), input.resume === true, {
      acceptPlatformCosts: true,
      acceptPlatformEligibility: true,
      action: store.kind,
    });
    this.wake(store.kind as SocialWorkflowKind);
    return result;
  }
  async cancel(owner: string, kind: unknown, id: string) {
    const current = await this.detail(owner, kind, id),
      authorization = await this.sources.space(owner, current.plan.spaceId, current.plan.sourceProjectId),
      store = this.store(kind),
      result = store.transaction(() => {
        authorization();
        return store.cancel(owner, id);
      });
    this.wake(store.kind as SocialWorkflowKind);
    return result;
  }
}
