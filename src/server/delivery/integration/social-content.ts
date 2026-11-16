import { isDeepStrictEqual } from "node:util";
import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import type { ContentIR } from "../../../shared/publishing/content.js";
import type { VariantDetail } from "../../../shared/publishing/variants.js";
import type { PublicationImage, UploadedMedia } from "../../../shared/delivery/media.js";
import type { SocialSource } from "../../../shared/delivery/social.js";
import type { XArticleDraft } from "../../../shared/publishing/x-article.js";
import type { SocialCapture } from "../social/ports.js";
import { contentImages, localAssetId } from "../../publishing/content/walk.js";
import { xArticleDraft } from "../../publishing/adapters/x/article-content.js";
import { X_IMAGE_MAX_BYTES } from "../adapters/x/media-client.js";
import { DeliveryError } from "../errors.js";

/** Channel mapping consumes already authorized saved data; it never reads storage or accepts submitted platform bodies. */
export function socialContent(
  detail: VariantDetail,
  ir: ContentIR,
  location: { projectId: string; spaceId: string },
  assets: DocumentAsset[],
): SocialCapture {
  const variant = detail.variant;
  if (detail.stale) throw new DeliveryError("staleSource", 409);
  if (!detail.review || detail.review.digest !== detail.digest) throw new DeliveryError("reviewRequired", 409);
  if (variant.issues.some((issue) => issue.severity === "blocking")) throw new DeliveryError("blockedContent", 409);
  const images = contentImages(ir);
  if (images.length > 64) throw new DeliveryError("mediaLimit", 409);
  const media: PublicationImage[] = images.map((image, index) => {
    const assetId = localAssetId(image.source),
      asset = assets.find((item) => item.id === assetId);
    if (!assetId || !asset || asset.documentId !== variant.source.documentId)
      throw new DeliveryError("mediaRequired", 409);
    if (asset.size > X_IMAGE_MAX_BYTES) throw new DeliveryError("mediaTooLarge", 409);
    if (Array.from(image.alt).length > 1000) throw new DeliveryError("mediaAltTooLong", 409);
    return {
      key: "m" + (index + 1),
      assetId,
      ...image,
      name: asset.name,
      mime: asset.mime,
      digest: asset.digest,
      size: asset.size,
    };
  });
  if (media.length && variant.formatterVersion !== "2") throw new DeliveryError("mediaReviewRequired", 409);
  const source = {
    ...variant.source,
    variantId: variant.id,
    variantDigest: detail.digest,
    templateId: variant.templateId,
    templateVersion: variant.templateVersion,
    formatterVersion: variant.formatterVersion,
  };
  if (variant.format === "x-article") {
    const article = xArticleDraft(ir);
    if (article.issues.some((issue) => issue.severity === "blocking")) throw new DeliveryError("blockedContent", 409);
    return { ...location, source, media, content: { format: "x-article", draft: article.payload } };
  }
  if (
    !["x-post", "x-thread"].includes(variant.format) ||
    !variant.posts.length ||
    variant.posts.some((post) => !post.valid)
  )
    throw new DeliveryError("blockedContent", 409);
  return {
    ...location,
    source,
    media,
    content: {
      format: variant.format as "x-post" | "x-thread",
      posts: variant.posts.map((post) => post.text),
      postMedia: variant.posts.map((post) =>
        (post.imageIndexes ?? []).map((index) => {
          if (!media[index]) throw new DeliveryError("invalidSnapshot", 409);
          return media[index].key;
        }),
      ),
    },
  };
}
export function assertSocialSource(current: SocialCapture, source: SocialSource, projectId: string, spaceId: string) {
  if (current.projectId !== projectId || current.spaceId !== spaceId || !isDeepStrictEqual(current.source, source))
    throw new DeliveryError("staleSource", 409);
}
export function socialArticle(
  ir: ContentIR,
  current: SocialCapture,
  source: SocialSource,
  preview: XArticleDraft,
  images: { image: PublicationImage; uploaded: UploadedMedia }[],
) {
  assertSocialSource(current, source, current.projectId, current.spaceId);
  if (
    current.content.format !== "x-article" ||
    !isDeepStrictEqual(current.content.draft, preview) ||
    images.length !== current.media.length
  )
    throw new DeliveryError("staleSource", 409);
  const mapping = new Map(
    images.map(({ image, uploaded }) => {
      if (!current.media.some((item) => isDeepStrictEqual(item, image)))
        throw new DeliveryError("invalidSnapshot", 409);
      return [
        JSON.stringify([image.blockId, image.source, image.alt]),
        { media_id: uploaded.mediaId, media_category: uploaded.category },
      ] as const;
    }),
  );
  const result = xArticleDraft(ir, mapping);
  if (result.issues.some((issue) => issue.code === "imageNeedsUpload" || issue.severity === "blocking"))
    throw new DeliveryError("mediaRequired", 409);
  return result.payload;
}
