import type { JsonValue, WorkflowPlan } from "../../../../shared/delivery/workflow.js";
import { DeliveryError } from "../../errors.js";
import { socialPayload } from "../../social/payload.js";
import type { SocialAccounts, SocialSources } from "../../social/ports.js";
import type { AwaitableWorkflowEffects } from "../../workflows/async-ports.js";
import type { WorkflowHandler } from "../../workflows/ports.js";
import type { XPublicationClient } from "./client.js";
import { acknowledgedOperation, confirmedOperation } from "./confirmed-operation.js";
import { requireReady } from "./media-state.js";
import type { XPublicationMedia } from "./media-workflow.js";
function confirmedPost(receipt: JsonValue, account: string): string {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    typeof receipt.postId !== "string" ||
    !/^[0-9]{1,19}$/.test(receipt.postId) ||
    receipt.accountId !== account
  )
    throw new DeliveryError("invalidReceipt", 409);
  return receipt.postId;
}
/** Composes platform steps while the common workflow runtime owns leases, retries and durable receipts. */
export class XPublicationWorkflow implements WorkflowHandler {
  constructor(
    private accounts: Pick<SocialAccounts, "access">,
    private client: XPublicationClient,
    readonly authorize: (owner: string, plan: WorkflowPlan) => (() => void) | Promise<() => void>,
    private sources: Pick<SocialSources, "article">,
    private media: XPublicationMedia,
    private now = Date.now,
  ) {}
  async execute(owner: string, plan: WorkflowPlan, effects: AwaitableWorkflowEffects): Promise<JsonValue> {
    const payload = socialPayload(plan);
    if ("draftJobId" in payload) {
      const access = await this.accounts.access(owner, payload.target);
      return effects.run(
        "article.publish",
        "article.publish",
        { articleId: payload.articleId, accountId: payload.target.accountId },
        () => this.client.publishArticle(access, payload.articleId),
      );
    }
    const content = payload.content;
    if (content.format === "x-article") {
      const previous = await acknowledgedOperation(effects, "article.draft");
      if (previous?.outcome === "succeeded") return previous.result;
      const images = await this.media.prepare(owner, payload, payload.media || [], effects);
      const draft = images.length
        ? await this.sources.article(owner, payload.source, content.draft, images)
        : content.draft;
      const access = await this.accounts.access(owner, payload.target);
      requireReady(
        images.map((item) => item.uploaded),
        payload.target.accountId,
        this.now(),
      );
      return confirmedOperation(
        effects,
        "article.draft",
        "article.draft",
        { article: draft as unknown as JsonValue, accountId: payload.target.accountId },
        () => this.client.draft(access, draft),
      );
    }
    const posts: JsonValue[] = [];
    let previous: string | undefined;
    for (const [index, text] of content.posts.entries()) {
      const key = `post.${index + 1}`,
        existing = await acknowledgedOperation(effects, key);
      if (existing?.outcome === "succeeded") {
        previous = confirmedPost(existing.result, payload.target.accountId);
        posts.push(existing.result);
        continue;
      }
      const images = await this.media.prepare(
        owner,
        payload,
        (content.postMedia?.[index] || []).map((key) => {
          const image = payload.media?.find((image) => image.key === key);
          if (!image) throw new DeliveryError("invalidSnapshot", 409);
          return image;
        }),
        effects,
      );
      const access = await this.accounts.access(owner, payload.target);
      requireReady(
        images.map((item) => item.uploaded),
        payload.target.accountId,
        this.now(),
      );
      const input = {
        text,
        ...(previous ? { replyTo: previous } : {}),
        ...(images.length ? { mediaIds: images.map((item) => item.uploaded.mediaId) } : {}),
      };
      const result = await confirmedOperation(
        effects,
        key,
        "post.create",
        { ...input, accountId: payload.target.accountId },
        () => this.client.post(access, input),
      );
      previous = confirmedPost(result, payload.target.accountId);
      posts.push(result);
    }
    return { accountId: payload.target.accountId, posts };
  }
}
