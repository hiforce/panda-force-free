import { mapMetadata, metadataFailure } from "../../../shared/async-value.js";
import type { ProjectDocumentSources } from "../../documents/source-port.js";
import type { ProjectDocumentQueries } from "../../documents/editor-port.js";
import type { FileDocumentAssets } from "../../documents/files/assets.js";
import { DocumentError } from "../../documents/errors.js";
import { PublicationError } from "../errors.js";
import type { PublicationSources, PublicationAssets } from "../content/source-port.js";

/** File readers expose saved immutable content; scope and policy remain application-owned. */
export function filePublicationSources(options: {
  queries: ProjectDocumentSources & Pick<ProjectDocumentQueries, "record">;
  assets: Pick<FileDocumentAssets, "metadata" | "content">;
  requireProject(projectId: string): unknown;
}): { sources: PublicationSources; assets: PublicationAssets } {
  function scope(projectId?: string) {
    if (!projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId)) throw new PublicationError("invalidInput");
    return projectId;
  }
  function failure(error: unknown): never {
    if (error instanceof DocumentError)
      throw new PublicationError(error.status === 404 ? "notFound" : "unavailable", error.status);
    throw error;
  }
  async function read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      return failure(error);
    }
  }
  return {
    sources: {
      authorize: (id, project) =>
        read(async () => {
          const projectId = scope(project);
          await options.queries.record(projectId, id);
          const guard = () => metadataFailure(() => mapMetadata(options.requireProject(projectId), () => {}), failure);
          await guard();
          return guard;
        }),
      current: (id, project) =>
        read(async () => ({
          revisionId: (await options.queries.record(scope(project), id)).revisionId,
        })),
      revision: (id, revisionId, project) =>
        read(async () => {
          const projectId = scope(project),
            captured = await options.queries.source(projectId, id, revisionId),
            revision = captured.revision;
          if (captured.projectId !== projectId || captured.document.id !== id || revision.id !== revisionId)
            throw new PublicationError("unavailable", 503);
          return {
            projectId,
            commit: captured.commit,
            documentId: id,
            revisionId,
            content: revision.content,
            ...(revision.body ? { body: revision.body } : {}),
            title: revision.title,
            locale: revision.locale,
            engine: captured.engine,
            ...(revision.resources ? { resources: revision.resources } : {}),
          };
        }),
    },
    assets: {
      content: (documentId, assetId, project) =>
        read(async () => {
          const projectId = scope(project),
            metadata = await options.assets.metadata(projectId, assetId);
          if (metadata.documentId !== documentId) throw new PublicationError("assetUnavailable", 404);
          const result = await options.assets.content(projectId, assetId);
          if (result.asset.documentId !== documentId || result.asset.digest !== metadata.digest)
            throw new PublicationError("assetUnavailable", 404);
          return { name: result.asset.name, mime: result.asset.mime, digest: result.asset.digest, bytes: result.bytes };
        }),
    },
  };
}
