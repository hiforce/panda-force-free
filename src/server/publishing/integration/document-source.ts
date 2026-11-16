import { mapMetadata, metadataFailure, type MetadataStore } from "../../../shared/async-value.js";
import type { DocumentService } from "../../documents/service.js";
import type { DocumentAssets } from "../../documents/assets.js";
import { DocumentError } from "../../documents/errors.js";
import { PublicationError } from "../errors.js";
import type { PublicationSources, PublicationAssets } from "../content/source-port.js";

/** Only this bridge knows the document application's repository and permission model. */
export function documentPublicationSources(
  documents: MetadataStore<Pick<DocumentService, "detail">> & {
    documents: MetadataStore<Pick<DocumentService["documents"], "revision">>;
    spaces: MetadataStore<Pick<DocumentService["spaces"], "get">>;
  },
  assets: { repository: MetadataStore<Pick<DocumentAssets["repository"], "get">>; content: DocumentAssets["content"] },
): { sources: PublicationSources; assets: PublicationAssets } {
  function access<T>(read: () => T): T {
    return metadataFailure(read, (error) => {
      if (error instanceof DocumentError)
        throw new PublicationError(error.status === 404 ? "notFound" : "unavailable", error.status);
      throw error;
    });
  }
  function scope(projectId?: string) {
    if (projectId !== undefined) throw new PublicationError("notFound", 404);
  }
  return {
    sources: {
      authorize: (documentId, projectId) => {
        scope(projectId);
        const guard = () => access(() => mapMetadata(documents.detail(documentId), () => {}));
        return mapMetadata(guard(), () => guard);
      },
      current: (documentId, projectId) =>
        access(() => {
          scope(projectId);
          return mapMetadata(documents.detail(documentId), (detail) => ({ revisionId: detail.document.revisionId }));
        }),
      revision: (documentId, revisionId, projectId) =>
        access(async () => {
          scope(projectId);
          const { document } = await documents.detail(documentId),
            revision = await documents.documents.revision(documentId, revisionId),
            space = await documents.spaces.get(document.spaceId);
          return {
            documentId,
            revisionId: revision.id,
            content: revision.content,
            ...(revision.body ? { body: revision.body } : {}),
            title: revision.title,
            locale: revision.locale,
            engine: space.engine,
            resources: revision.resources,
          };
        }),
    },
    assets: {
      async content(documentId, id, projectId) {
        scope(projectId);
        await access(() => documents.detail(documentId));
        const owned = await access(() => assets.repository.get(id));
        if (owned.documentId !== documentId) throw new PublicationError("assetUnavailable", 404);
        try {
          const value = await assets.content(id);
          return { ...value.asset, bytes: value.bytes };
        } catch {
          throw new PublicationError("assetUnavailable", 404);
        }
      },
    },
  };
}
