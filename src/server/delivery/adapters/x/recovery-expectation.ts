import type { WorkflowRecord } from "../../../../shared/delivery/workflow.js";
import { executionWorkflowSteps } from "../../../../shared/delivery/recovery.js";
import { socialPayload } from "../../social/payload.js";
import { workflowJson } from "../../storage/json.js";
import { digest } from "../../digest.js";
import { DeliveryError } from "../../errors.js";
import { mediaReceipt } from "./media-state.js";
import { xIdentifier } from "./response.js";

/** Reconstruct only requests whose immutable digest and preceding receipts still agree. */
export function xRecoveryExpectation(record: WorkflowRecord, stepId: number) {
  const payload = socialPayload(record.plan),
    steps = executionWorkflowSteps(record),
    step = steps.find((item) => item.id === stepId),
    index = step && /^post\.([1-9][0-9]*)(?:\.g[1-9][0-9]*)?$/.exec(step.key);
  if (
    !step ||
    step.operation !== "post.create" ||
    step.outcome !== "pending" ||
    !index ||
    !("content" in payload) ||
    payload.content.format === "x-article"
  )
    throw new DeliveryError("recoveryUnsupported", 409);
  const number = Number(index[1]),
    text = payload.content.posts[number - 1];
  if (text === undefined) throw new DeliveryError("invalidSnapshot", 409);
  let replyTo: string | undefined;
  if (number > 1) {
    const previous = steps
        .filter((item) => item.id < step.id && new RegExp(`^post\\.${number - 1}(?:\\.g[1-9][0-9]*)?$`).test(item.key))
        .at(-1),
      value = previous?.result;
    if (
      previous?.outcome !== "succeeded" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !xIdentifier(value.postId) ||
      value.accountId !== payload.target.accountId
    )
      throw new DeliveryError("invalidReceipt", 409);
    replyTo = value.postId;
  }
  const images = (payload.content.postMedia?.[number - 1] || []).map((key) => {
    const upload = steps
      .filter((item) => item.id < step.id && item.key.startsWith(`media.${key}.`) && item.operation === "media.upload")
      .at(-1);
    if (upload?.outcome !== "succeeded") throw new DeliveryError("invalidReceipt", 409);
    return mediaReceipt(upload.result, payload.target.accountId);
  });
  const input = {
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(images.length ? { mediaIds: images.map((image) => image.mediaId) } : {}),
    accountId: payload.target.accountId,
  };
  if (digest(workflowJson(input, 1024 * 1024)) !== step.requestHash) throw new DeliveryError("invalidSnapshot", 409);
  // Old upload receipts may not contain a media key. Never infer it from a numeric ID.
  if (images.some((image) => !image.mediaKey)) throw new DeliveryError("recoveryMediaUnavailable", 409);
  return {
    text,
    replyTo,
    accountId: payload.target.accountId,
    mediaKeys: images.map((image) => image.mediaKey!),
    attemptedAt: step.createdAt,
  };
}
