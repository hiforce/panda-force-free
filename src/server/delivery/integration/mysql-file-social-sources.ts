import { isDeepStrictEqual } from "node:util";
import type { ProjectDocumentQueries } from "../../documents/editor-port.js";
import { DocumentError } from "../../documents/errors.js";
import type { FileDocumentAssets } from "../../documents/files/assets.js";
import type { FileDocumentSpaces } from "../../documents/files/spaces/service.js";
import { PublicationError } from "../../publishing/errors.js";
import type { FileVariantRepository } from "../../publishing/file-variant-repository.js";
import type { VariantService } from "../../publishing/variant-service.js";
import { DeliveryError } from "../errors.js";
import type { AsyncSocialSources } from "../social/async-ports.js";
import { assertSocialSource, socialArticle, socialContent } from "./social-content.js";

function sourceFailure(error: unknown): never {
  if (error instanceof DocumentError || error instanceof PublicationError)
    throw new DeliveryError(error.code, error.status);
  throw error;
}
async function sourceRead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return sourceFailure(error);
  }
}
function sourceGuard(work: () => void | Promise<void>) {
  return async () => {
    try {
      await work();
    } catch (error) {
      sourceFailure(error);
    }
  };
}
function captureGuard(work: () => void | Promise<void>) {
  return async () => {
    try {
      await work();
    } catch (error) {
      sourceFailure(error);
    }
  };
}

export function mysqlFileSocialSources(options: {
  variants: Pick<VariantService, "capture">;
  reference(
    ...args: Parameters<FileVariantRepository["reference"]>
  ): ReturnType<FileVariantRepository["reference"]> | Promise<ReturnType<FileVariantRepository["reference"]>>;
  queries: Pick<ProjectDocumentQueries, "record">;
  assets: Pick<FileDocumentAssets, "list" | "content">;
  spaces: Pick<FileDocumentSpaces, "get">;
  requireProject(project: string): unknown;
}): AsyncSocialSources {
  function view(id: string) {
    return sourceRead(async () => {
      const snapshot = await options.variants.capture(id),
        ref = snapshot.detail.variant.source,
        projectId = ref.projectId;
      if (!projectId) throw new DeliveryError("notFound", 404);
      const document = await options.queries.record(projectId, ref.documentId),
        assets = await options.assets.list(projectId, ref.documentId),
        latest = await options.queries.record(projectId, ref.documentId);
      if (latest.spaceId !== document.spaceId || latest.revisionId !== ref.revisionId)
        throw new DeliveryError("staleSource", 409);
      await snapshot.guard();
      return {
        current: socialContent(snapshot.detail, snapshot.ir, { projectId, spaceId: document.spaceId }, assets),
        ir: snapshot.ir,
        guard: captureGuard(snapshot.guard),
      };
    });
  }
  return {
    capture: async (_owner, id) => (await view(id)).current,
    async authorize(_owner, source, projectId, spaceId) {
      // Execution needs fresh source/review identity, not another full body read or channel conversion.
      const guard = sourceGuard(async () => {
        await options.requireProject(projectId);
        const current = await options.reference(source.variantId);
        if (
          !current ||
          source.projectId !== projectId ||
          current.digest !== source.variantDigest ||
          !isDeepStrictEqual(current.source, {
            documentId: source.documentId,
            revisionId: source.revisionId,
            sourceHash: source.sourceHash,
            projectId: source.projectId,
            commit: source.commit,
          })
        )
          throw new DeliveryError("staleSource", 409);
        if (!current.review || current.review.digest !== current.digest) throw new DeliveryError("reviewRequired", 409);
      });
      await guard();
      const current = await sourceRead(() => options.queries.record(projectId, source.documentId));
      if (
        current.spaceId !== spaceId ||
        current.revisionId !== source.revisionId ||
        current.contentHash !== source.sourceHash
      )
        throw new DeliveryError("staleSource", 409);
      await guard();
      return guard;
    },
    async space(_owner, spaceId, projectId) {
      if (!projectId) throw new DeliveryError("notFound", 404);
      const read = await sourceRead(() => options.spaces.get(projectId, spaceId));
      if (read.space.projectId !== projectId || read.space.id !== spaceId) throw new DeliveryError("notFound", 404);
      const guard = sourceGuard(async () => {
        await options.requireProject(projectId);
      });
      await guard();
      return guard;
    },
    async readImage(_owner, source, image) {
      const captured = await view(source.variantId),
        current = captured.current;
      assertSocialSource(current, source, current.projectId, current.spaceId);
      if (!current.media.some((item) => isDeepStrictEqual(item, image))) throw new DeliveryError("staleSource", 409);
      const { asset, bytes } = await sourceRead(() => options.assets.content(current.projectId, image.assetId));
      if (asset.documentId !== source.documentId || asset.digest !== image.digest || bytes.length !== image.size)
        throw new DeliveryError("staleSource", 409);
      await captured.guard();
      return bytes;
    },
    async article(_owner, source, preview, images) {
      const { current, ir, guard } = await view(source.variantId);
      const draft = socialArticle(ir, current, source, preview, images);
      await guard();
      return draft;
    },
  };
}
