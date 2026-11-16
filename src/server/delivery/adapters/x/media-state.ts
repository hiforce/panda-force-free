import type { UploadedMedia } from "../../../../shared/delivery/media.js";
import type { JsonValue } from "../../../../shared/delivery/workflow.js";
import { DeliveryError } from "../../errors.js";

/** Receipts are untrusted persisted data, even when an earlier worker wrote them. */
export function mediaReceipt(value: JsonValue, account: string): UploadedMedia {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.mediaId !== "string" ||
    !/^[0-9]{1,19}$/.test(value.mediaId) ||
    (value.mediaKey !== undefined &&
      (typeof value.mediaKey !== "string" || !/^[0-9]+_[0-9]{1,19}$/.test(value.mediaKey))) ||
    value.accountId !== account ||
    value.category !== "tweet_image" ||
    !["pending", "in_progress", "failed", "succeeded"].includes(String(value.state)) ||
    !Number.isSafeInteger(value.observedAt) ||
    (value.expiresAt !== null && !Number.isSafeInteger(value.expiresAt)) ||
    (value.checkAt !== null && !Number.isSafeInteger(value.checkAt)) ||
    (value.progress !== null &&
      (!Number.isInteger(value.progress) || Number(value.progress) < 0 || Number(value.progress) > 100))
  )
    throw new DeliveryError("invalidReceipt", 409);
  return value as unknown as UploadedMedia;
}

export function requireReady(images: UploadedMedia[], account: string, now = Date.now()) {
  for (const image of images) {
    if (image.accountId !== account || image.state !== "succeeded") throw new DeliveryError("mediaNotReady", 409);
    if (image.expiresAt === null) throw new DeliveryError("mediaExpiryUnavailable", 409);
    if (image.expiresAt <= now + 1000) throw new DeliveryError("mediaExpired", 409);
  }
}
