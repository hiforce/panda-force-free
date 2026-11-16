import type { PublicationImage, UploadedMedia } from "../../../../shared/delivery/media.js";
import type { SocialPayload } from "../../../../shared/delivery/social.js";
import type { JsonValue } from "../../../../shared/delivery/workflow.js";
import { DeliveryError } from "../../errors.js";
import type { SocialAccounts, SocialSources } from "../../social/ports.js";
import type { AwaitableWorkflowEffects } from "../../workflows/async-ports.js";
import { RemoteOperationError } from "../../workflows/errors.js";
import type { XMediaClient } from "./media-client.js";
import { XMediaPoll } from "./media-poll.js";
import { mediaReceipt, requireReady } from "./media-state.js";
/** Associates document occurrences with account-bound uploads; state and retries live in the workflow store. */
export class XPublicationMedia {
  private poll: XMediaPoll;
  constructor(
    private sources: Pick<SocialSources, "readImage">,
    private accounts: Pick<SocialAccounts, "access">,
    private client: XMediaClient,
    private now = Date.now,
  ) {
    this.poll = new XMediaPoll(client, now);
  }
  async prepare(owner: string, payload: SocialPayload, images: PublicationImage[], effects: AwaitableWorkflowEffects) {
    const results: {
      image: PublicationImage;
      uploaded: UploadedMedia;
    }[] = [];
    for (const image of images) results.push({ image, uploaded: await this.image(owner, payload, image, effects) });
    requireReady(
      results.map((item) => item.uploaded),
      payload.target.accountId,
      this.now(),
    );
    return results;
  }
  private async image(
    owner: string,
    payload: SocialPayload,
    image: PublicationImage,
    effects: AwaitableWorkflowEffects,
  ) {
    const snapshot = await effects.inspect(),
      prefix = `media.${image.key}.`,
      previous = snapshot.steps
        .filter((step) => step.key.startsWith(prefix) && step.operation === "media.upload")
        .at(-1),
      access = () => this.accounts.access(owner, payload.target, "media");
    if (previous?.outcome === "pending") throw new RemoteOperationError("outcomeUnknown", "unknown");
    let key = previous?.key || `${prefix}g${snapshot.confirmation}.upload`;
    if (previous?.outcome === "succeeded") {
      const uploaded = mediaReceipt(previous.result, payload.target.accountId),
        current = (await this.poll.current(effects, `${key}.status`, uploaded)).media;
      if (current.state === "failed" || (current.expiresAt !== null && current.expiresAt <= this.now() + 1000)) {
        const generation = Number(/\.g([0-9]+)\.upload$/.exec(key)?.[1]);
        if (!generation || generation >= snapshot.confirmation)
          throw new DeliveryError(current.state === "failed" ? "mediaProcessingFailed" : "mediaExpired", 409);
        key = `${prefix}g${snapshot.confirmation}.upload`;
      }
    }
    // Verify immutable local bytes even when resuming a previously acknowledged upload.
    const bytes = await this.sources.readImage(owner, payload.source, image);
    const credential = await access();
    const receipt = await effects.run(
      key,
      "media.upload",
      {
        assetId: image.assetId,
        digest: image.digest,
        size: image.size,
        mime: image.mime,
        accountId: payload.target.accountId,
      },
      async () => (await this.client.upload(credential, bytes, image.mime)) as unknown as JsonValue,
    );
    const uploaded = await this.poll.ready(
      effects,
      `${key}.status`,
      mediaReceipt(receipt, payload.target.accountId),
      access,
    );
    const metadataKey = key.replace(/\.upload$/, ".metadata");
    if (image.alt) {
      const credential = await access();
      requireReady([uploaded], payload.target.accountId, this.now());
      await effects.run(
        metadataKey,
        "media.metadata",
        { mediaId: uploaded.mediaId, accountId: payload.target.accountId, alt: image.alt },
        () => this.client.metadata(credential, uploaded.mediaId, image.alt),
      );
      for (const step of (await effects.inspect()).steps) {
        if (
          step.key.startsWith(prefix) &&
          step.operation === "media.metadata" &&
          step.outcome === "rejected" &&
          step.replacedBy === null &&
          step.key !== metadataKey
        )
          await effects.replaceRejected(step.key, metadataKey);
      }
    }
    requireReady([uploaded], payload.target.accountId, this.now());
    return uploaded;
  }
}
