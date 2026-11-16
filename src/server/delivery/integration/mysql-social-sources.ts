import { isDeepStrictEqual } from "node:util";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { DocumentAssets } from "../../documents/assets.js";
import type { DocumentService } from "../../documents/service.js";
import type { VariantStore } from "../../publishing/ports.js";
import { DeliveryError } from "../errors.js";
import type { AsyncSocialSources } from "../social/async-ports.js";
import { assertSocialSource, socialArticle, socialContent } from "./social-content.js";
/** Relational document/variant metadata is always awaited; stored source scope fixes this adapter. */
export function mysqlSocialSources(
  documents: MetadataStore<Pick<DocumentService, "detail" | "listSpaces">> & {
    spaces: MetadataStore<Pick<DocumentService["spaces"], "get">>;
  },
  variants: Pick<VariantStore, "get" | "source">,
  assets: { repository: MetadataStore<Pick<DocumentAssets["repository"], "list">>; content: DocumentAssets["content"] },
): AsyncSocialSources {
  async function view(id: string) {
    const detail = await variants.get(id),
      variant = detail.variant;
    if (variant.source.projectId !== undefined) throw new DeliveryError("notFound", 404);
    const document = await documents.detail(variant.source.documentId),
      space = await documents.spaces.get(document.document.spaceId),
      ir = await variants.source(id);
    return {
      current: socialContent(
        { ...detail, stale: document.document.revisionId !== variant.source.revisionId },
        ir,
        { projectId: space.projectId, spaceId: space.id },
        await assets.repository.list(document.document.id),
      ),
      ir,
    };
  }
  return {
    capture: async (_owner, id) => (await view(id)).current,
    async authorize(_owner, source, project, space) {
      const guard = async () => assertSocialSource((await view(source.variantId)).current, source, project, space);
      await guard();
      return guard;
    },
    async space(_owner, spaceId, project) {
      if (project !== undefined) throw new DeliveryError("notFound", 404);
      const guard = async () => {
        const space = await documents.spaces.get(spaceId);
        await documents.listSpaces(space.projectId);
      };
      await guard();
      return guard;
    },
    async readImage(_owner, source, image) {
      const current = (await view(source.variantId)).current;
      assertSocialSource(current, source, current.projectId, current.spaceId);
      if (!current.media.some((value) => isDeepStrictEqual(value, image))) throw new DeliveryError("staleSource", 409);
      const { asset, bytes } = await assets.content(image.assetId);
      if (asset.documentId !== source.documentId || asset.digest !== image.digest || bytes.length !== image.size)
        throw new DeliveryError("staleSource", 409);
      assertSocialSource((await view(source.variantId)).current, source, current.projectId, current.spaceId);
      return bytes;
    },
    async article(_owner, source, preview, images) {
      const { current, ir } = await view(source.variantId);
      return socialArticle(ir, current, source, preview, images);
    },
  };
}
