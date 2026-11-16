import { isDeepStrictEqual } from "node:util";
import type { DocumentService } from "../../documents/service.js";
import type { VariantRepository } from "../../publishing/variant-repository.js";
import type { DocumentAssets } from "../../documents/assets.js";
import type { SocialSources } from "../social/ports.js";
import { socialContent, socialArticle, assertSocialSource } from "./social-content.js";
import { DeliveryError } from "../errors.js";

/** Legacy policy can run synchronously inside a queue transaction; file variants are explicitly excluded. */
export function socialSources(
  documents: DocumentService,
  variants: Pick<VariantRepository, "get" | "source">,
  assets: DocumentAssets,
): SocialSources {
  function view(id: string) {
    const detail = variants.get(id),
      variant = detail.variant;
    if (variant.source.projectId !== undefined) throw new DeliveryError("notFound", 404);
    const document = documents.detail(variant.source.documentId),
      space = documents.spaces.get(document.document.spaceId),
      ir = variants.source(id);
    const current = socialContent(
      { ...detail, stale: document.document.revisionId !== variant.source.revisionId },
      ir,
      { projectId: space.projectId, spaceId: space.id },
      assets.repository.list(document.document.id),
    );
    return { current, ir };
  }
  return {
    capture: (_owner, id) => view(id).current,
    authorize(_owner, source, projectId, spaceId) {
      const guard = () => assertSocialSource(view(source.variantId).current, source, projectId, spaceId);
      guard();
      return guard;
    },
    space(_owner, spaceId, projectId) {
      if (projectId !== undefined) throw new DeliveryError("notFound", 404);
      const guard = () => {
        const space = documents.spaces.get(spaceId);
        documents.listSpaces(space.projectId);
      };
      guard();
      return guard;
    },
    async readImage(_owner, source, image) {
      const current = view(source.variantId).current;
      assertSocialSource(current, source, current.projectId, current.spaceId);
      if (!current.media.some((item) => isDeepStrictEqual(item, image))) throw new DeliveryError("staleSource", 409);
      const { asset, bytes } = await assets.content(image.assetId);
      if (asset.documentId !== source.documentId || asset.digest !== image.digest || bytes.length !== image.size)
        throw new DeliveryError("staleSource", 409);
      return bytes;
    },
    article(_owner, source, preview, images) {
      const { current, ir } = view(source.variantId);
      return socialArticle(ir, current, source, preview, images);
    },
  };
}
