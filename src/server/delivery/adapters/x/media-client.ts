import type { UploadedMedia } from "../../../../shared/delivery/media.js";
import type { XAccess, XJsonTransport } from "./http.js";
import { xData, xIdentifier, invalidXInput, malformedXResponse } from "./response.js";

export const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Only accepts verified local image bytes. Uploading media never creates a Post or Article. */
export class XMediaClient {
  constructor(
    private http: XJsonTransport,
    private now = Date.now,
  ) {}

  private decode(response: Record<string, unknown>, accountId: string, startedAt: number): UploadedMedia {
    const value = xData(response);
    if (!xIdentifier(value.id)) throw malformedXResponse();
    if (
      value.media_key !== undefined &&
      (typeof value.media_key !== "string" || !/^[0-9]+_[0-9]{1,19}$/.test(value.media_key))
    )
      throw malformedXResponse();
    const seconds = value.expires_after_secs;
    if (
      seconds !== undefined &&
      (!Number.isSafeInteger(seconds) || Number(seconds) <= 0 || Number(seconds) > 31 * 86400)
    )
      throw malformedXResponse();
    let state: UploadedMedia["state"] = "succeeded",
      checkAt: number | null = null,
      progress: number | null = null;
    if (value.processing_info !== undefined) {
      const info = value.processing_info;
      if (!info || typeof info !== "object" || Array.isArray(info)) throw malformedXResponse();
      const item = info as Record<string, unknown>;
      if (!["pending", "in_progress", "failed", "succeeded"].includes(String(item.state))) throw malformedXResponse();
      state = item.state as UploadedMedia["state"];
      if (item.progress_percent !== undefined) {
        if (
          !Number.isInteger(item.progress_percent) ||
          Number(item.progress_percent) < 0 ||
          Number(item.progress_percent) > 100
        )
          throw malformedXResponse();
        progress = Number(item.progress_percent);
      }
      if (["pending", "in_progress"].includes(state)) {
        const delay = item.check_after_secs ?? 1;
        if (!Number.isInteger(delay) || Number(delay) < 0 || Number(delay) > 3600) throw malformedXResponse();
        checkAt = this.now() + Math.max(1, Number(delay)) * 1000;
      }
    }
    return {
      mediaId: value.id,
      ...(typeof value.media_key === "string" ? { mediaKey: value.media_key } : {}),
      accountId,
      category: "tweet_image",
      state,
      expiresAt: seconds === undefined ? null : startedAt + Number(seconds) * 1000,
      checkAt,
      progress,
      observedAt: this.now(),
    };
  }

  async upload(access: XAccess, bytes: Uint8Array, mime: string): Promise<UploadedMedia> {
    if (!bytes.length || bytes.length > X_IMAGE_MAX_BYTES || !imageTypes.has(mime)) throw invalidXInput();
    const startedAt = this.now();
    const response = await this.http.request(
      "/2/media/upload",
      access,
      JSON.stringify({
        media: Buffer.from(bytes).toString("base64"),
        media_category: "tweet_image",
      }),
    );
    return this.decode(response, access.accountId, startedAt);
  }

  async status(access: XAccess, previous: UploadedMedia): Promise<UploadedMedia> {
    if (!xIdentifier(previous.mediaId) || previous.accountId !== access.accountId) throw invalidXInput();
    const startedAt = this.now();
    const response = await this.http.request(
      `/2/media/upload?media_id=${previous.mediaId}&command=STATUS`,
      access,
      undefined,
      "GET",
    );
    const current = this.decode(response, access.accountId, startedAt);
    if (current.mediaId !== previous.mediaId) throw malformedXResponse();
    if (previous.mediaKey && current.mediaKey && previous.mediaKey !== current.mediaKey) throw malformedXResponse();
    if (previous.mediaKey) current.mediaKey = previous.mediaKey;
    // A status refresh must never extend the original upload's validity window.
    current.expiresAt =
      previous.expiresAt === null
        ? current.expiresAt
        : current.expiresAt === null
          ? previous.expiresAt
          : Math.min(previous.expiresAt, current.expiresAt);
    return current;
  }

  async metadata(access: XAccess, mediaId: string, alt: string) {
    if (!xIdentifier(mediaId) || typeof alt !== "string" || Array.from(alt).length > 1000) throw invalidXInput();
    const value = xData(
      await this.http.request(
        "/2/media/metadata",
        access,
        JSON.stringify({
          id: mediaId,
          metadata: { alt_text: { text: alt } },
        }),
      ),
    );
    if (value.id !== mediaId) throw malformedXResponse();
    return { mediaId, accountId: access.accountId, observedAt: this.now() };
  }
}
