import type { DocumentPlacementHistorySummary } from "../../../shared/documents/placements.js";
import type { DocumentSpace } from "../../../shared/documents/contracts.js";
import { documentApi, documentJson as json, DocumentApiError } from "../api.js";
import type { PublicationConfigurationApi } from "./port.js";
import { PublicationCommands, type PendingPublicationCommand } from "./commands.js";

/** Project identity is bound once. File requests never retry against the legacy document store. */
export function filePublicationApi(project: string, identity: string): PublicationConfigurationApi {
  const query = (fields: Record<string, string> = {}) => new URLSearchParams({ ...fields, project }).toString();
  const configuration = (id: string) =>
    json<Awaited<ReturnType<typeof documentApi.sourceProfile>>>("/api/project-document-spaces/detail?" + query({ id }));
  const recovery = new PublicationCommands(identity, project, ({ operationId, command }: PendingPublicationCommand) => {
    const { kind, resource, input } = command;
    if (kind === "space-create")
      return json("/api/project-document-spaces", "POST", { ...input, projectId: project, operationId });
    if (kind === "space-configure")
      return json("/api/project-document-spaces/detail?" + query({ id: resource! }), "PUT", { ...input, operationId });
    if (kind === "link-create")
      return json("/api/project-document-placements?" + query(), "POST", { ...input, operationId });
    return json(
      "/api/project-document-placements/detail?" + query({ id: resource! }),
      kind === "link-update" ? "PUT" : "DELETE",
      { ...input, operationId },
    );
  });
  const projectMatches = (value: string) => {
    if (value !== project) throw new DocumentApiError(404, { messageId: "documents.notFound" });
  };
  return {
    recovery,
    sources: {
      detail: (id) => json("/api/project-documents/source?" + query({ id })),
      history: (id) => json("/api/project-documents/revisions?" + query({ id })),
      revision: (id, revision) => json("/api/project-documents/revisions?" + query({ id, revision })),
    },
    spaces: {
      sourceProfile: configuration,
      themes: documentApi.themes,
      spaces: (id) => {
        projectMatches(id);
        return json("/api/project-document-spaces?" + query());
      },
      createSpace: (input) => {
        projectMatches(input.projectId);
        const { sourceRoot, ...fields } = input;
        return recovery.execute({
          kind: "space-create",
          input: {
            ...fields,
            ...(input.sourceMode === "external" ? { sourceRoot } : {}),
          },
        });
      },
      inspect: (path) => json("/api/project-document-spaces/inspect?" + query(), "POST", { path }),
      setTheme: (id, version, theme) =>
        recovery.execute<{ space: DocumentSpace }>({
          kind: "space-configure",
          resource: id,
          input: { version, theme },
        }),
      saveSourceProfile: (id, version, profile) =>
        recovery.execute({ kind: "space-configure", resource: id, input: { version, profile } }),
      sourceOptions: (id) => json("/api/project-document-spaces/source-profile/options?" + query({ id })),
      inspectSourceProfile: (id, locale, files, webp) =>
        json("/api/project-document-spaces/source-profile/inspect?" + query({ id }), "POST", { locale, files, webp }),
    },
    placements: {
      list: (document) => json("/api/project-document-placements?" + query({ document })),
      create: (input) => recovery.execute({ kind: "link-create", input }),
      update: (id, input) => {
        const { documentId: _documentId, spaceId: _spaceId, ...fields } = input;
        return recovery.execute({ kind: "link-update", resource: id, input: fields });
      },
      remove: (placement, spaceVersion) =>
        recovery.execute({
          kind: "link-remove",
          resource: placement.id,
          input: { version: placement.version, spaceVersion },
        }),
      history: async (id) => {
        const { events } = await json<{ events: DocumentPlacementHistorySummary[] }>(
          "/api/project-document-placements/history?" + query({ id }),
        );
        return {
          events: events.map(({ placement, audit }) => ({
            ...audit,
            placement: { path: placement.path, version: placement.version },
          })),
        };
      },
    },
  };
}
