import type { ArticlePublishPayload, SocialPayload, SocialWorkflowKind } from "../../../shared/delivery/social.js";
import type { WorkflowPlan } from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";

export const socialKinds: readonly SocialWorkflowKind[] = ["x-post", "x-article-draft", "x-article-publish"];
/** Payloads originate in the authorized source bridge, never from a submitted platform request body. */
export function socialPayload(plan: WorkflowPlan): SocialPayload | ArticlePublishPayload {
  if (!socialKinds.includes(plan.kind as SocialWorkflowKind)) throw new DeliveryError("invalidInput");
  const value = plan.payload as unknown as SocialPayload | ArticlePublishPayload;
  if (
    !value ||
    typeof value !== "object" ||
    ![1, 2].includes(value.adapterVersion) ||
    !value.target ||
    !value.source ||
    value.target.id !== plan.connectionId ||
    value.target.projectId !== plan.projectId ||
    !/^[0-9]{1,25}$/.test(value.target.accountId) ||
    !Number.isSafeInteger(value.target.version) ||
    value.target.version < 1 ||
    !/^[a-f0-9]{64}$/.test(value.source.sourceHash) ||
    !/^[a-f0-9]{64}$/.test(value.source.variantDigest) ||
    value.platformCosts !== "unknown"
  )
    throw new DeliveryError("invalidInput");
  if (
    value.source.projectId !== plan.sourceProjectId ||
    (value.source.projectId !== undefined &&
      (value.source.projectId !== plan.projectId ||
        !value.source.commit ||
        !/^[a-f0-9]{40}$/.test(value.source.commit))) ||
    (value.source.projectId === undefined && value.source.commit !== undefined)
  )
    throw new DeliveryError("invalidSnapshot", 409);
  const media = value.media || [];
  if (
    !Array.isArray(media) ||
    media.length > 64 ||
    (value.adapterVersion === 1 && media.length) ||
    (value.adapterVersion === 2 && !Array.isArray(value.media)) ||
    new Set(media.map((image) => image?.key)).size !== media.length ||
    media.some(
      (image) =>
        !image ||
        !/^m[1-9][0-9]?$/.test(image.key) ||
        !/^[a-f0-9-]{36}$/i.test(image.assetId) ||
        image.source !== `/api/document-assets/content?id=${image.assetId}` ||
        typeof image.blockId !== "string" ||
        !image.blockId ||
        typeof image.name !== "string" ||
        !image.name ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.mime) ||
        !/^[a-f0-9]{64}$/.test(image.digest) ||
        !Number.isSafeInteger(image.size) ||
        image.size <= 0 ||
        image.size > 5 * 1024 * 1024 ||
        typeof image.alt !== "string" ||
        Array.from(image.alt).length > 1000,
    )
  )
    throw new DeliveryError("invalidInput");
  if (plan.kind === "x-article-publish") {
    if (!("articleId" in value) || !/^[0-9]{1,19}$/.test(value.articleId) || typeof value.draftJobId !== "string")
      throw new DeliveryError("invalidInput");
  } else {
    if (!("content" in value) || !value.content) throw new DeliveryError("invalidInput");
    if (plan.kind === "x-article-draft") {
      if (value.content.format !== "x-article" || !value.content.draft?.content_state?.blocks?.length)
        throw new DeliveryError("invalidInput");
    } else if (
      value.content.format === "x-article" ||
      !["x-post", "x-thread"].includes(value.content.format) ||
      !Array.isArray(value.content.posts) ||
      !value.content.posts.length ||
      value.content.posts.length > 100 ||
      value.content.posts.some((post) => typeof post !== "string" || !post) ||
      (value.content.format === "x-post" && value.content.posts.length !== 1)
    )
      throw new DeliveryError("invalidInput");
    if (value.content.format !== "x-article") {
      const groups = value.content.postMedia;
      if (
        value.adapterVersion === 2 &&
        (!Array.isArray(groups) ||
          groups.length !== value.content.posts.length ||
          groups.some(
            (group) =>
              !Array.isArray(group) ||
              group.length > 4 ||
              group.some((key) => !media.some((image) => image.key === key)),
          ) ||
          groups.flat().length !== media.length ||
          new Set(groups.flat()).size !== media.length)
      )
        throw new DeliveryError("invalidInput");
    }
  }
  return value;
}
