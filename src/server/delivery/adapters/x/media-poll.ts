import type { UploadedMedia } from "../../../../shared/delivery/media.js";
import type { JsonValue } from "../../../../shared/delivery/workflow.js";
import { DeliveryError } from "../../errors.js";
import type { AwaitableWorkflowEffects } from "../../workflows/async-ports.js";
import { RemoteOperationError } from "../../workflows/errors.js";
import type { XAccess } from "./http.js";
import type { XMediaClient } from "./media-client.js";
import { mediaReceipt } from "./media-state.js";
/** Read-only processing checks have durable snapshots, bounded retries, and no mutation intents. */
export class XMediaPoll {
  constructor(
    private client: XMediaClient,
    private now = Date.now,
  ) {}
  async current(effects: AwaitableWorkflowEffects, key: string, uploaded: UploadedMedia) {
    const observation = (await effects.inspect()).observations.find((item) => item.key === key);
    if (!observation) return { media: uploaded, attempts: 0, startedAt: uploaded.observedAt };
    const result = observation.result;
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Number.isSafeInteger(result.attempts) ||
      Number(result.attempts) < 1 ||
      !Number.isSafeInteger(result.startedAt)
    )
      throw new DeliveryError("invalidReceipt", 409);
    const media = mediaReceipt(result.media ?? null, uploaded.accountId);
    if (
      media.mediaId !== uploaded.mediaId ||
      (uploaded.expiresAt !== null && (media.expiresAt === null || media.expiresAt > uploaded.expiresAt))
    )
      throw new DeliveryError("invalidReceipt", 409);
    return { media, attempts: Number(result.attempts), startedAt: Number(result.startedAt) };
  }
  async ready(
    effects: AwaitableWorkflowEffects,
    key: string,
    uploaded: UploadedMedia,
    access: () => Promise<XAccess>,
  ): Promise<UploadedMedia> {
    const saved = await this.current(effects, key, uploaded);
    const deadline = saved.startedAt + 30 * 60 * 1000;
    const defer = (until: number): never => {
      if (this.now() >= deadline) throw new DeliveryError("mediaProcessingTimeout", 409);
      return effects.wait(Math.min(deadline, until));
    };
    let media = saved.media;
    if (media.expiresAt !== null && media.expiresAt <= this.now() + 1000) throw new DeliveryError("mediaExpired", 409);
    if (media.state === "failed") throw new DeliveryError("mediaProcessingFailed", 409);
    if (media.state === "succeeded" && media.expiresAt !== null) return media;
    if (saved.attempts >= 120 || this.now() - saved.startedAt >= 30 * 60 * 1000)
      throw new DeliveryError("mediaProcessingTimeout", 409);
    if (media.checkAt !== null && media.checkAt > this.now()) defer(media.checkAt);
    const credential = await access();
    try {
      media = await this.client.status(credential, media);
    } catch (error) {
      if (
        !(error instanceof RemoteOperationError) ||
        !["platformUnavailable", "rateLimited"].includes(error.code) ||
        saved.attempts >= 5
      )
        throw error;
      media = { ...media, checkAt: this.now() + Math.min(60000, 2000 * 2 ** saved.attempts) };
      await effects.observe(key, { mediaId: media.mediaId, accountId: media.accountId }, {
        ...saved,
        media,
        attempts: saved.attempts + 1,
      } as unknown as JsonValue);
      defer(media.checkAt!);
    }
    await effects.observe(key, { mediaId: media.mediaId, accountId: media.accountId }, {
      ...saved,
      media,
      attempts: saved.attempts + 1,
    } as unknown as JsonValue);
    if (media.state === "failed") throw new DeliveryError("mediaProcessingFailed", 409);
    if (media.state !== "succeeded") defer(Math.max(this.now() + 1000, media.checkAt || 0));
    if (media.expiresAt === null) throw new DeliveryError("mediaExpiryUnavailable", 409);
    if (media.expiresAt <= this.now() + 1000) throw new DeliveryError("mediaExpired", 409);
    return media;
  }
}
