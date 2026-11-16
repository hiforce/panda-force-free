import type { DocumentPlacement } from "../../../../shared/documents/placements.js";
import type { ProjectDocumentPlacements } from "../../placement-port.js";
import { publicDocumentMetadata } from "../../../../shared/sites/metadata.js";
import { compatibleDocumentLocale } from "../../../../shared/documents/locales.js";
import { SiteProfileError } from "../../../../shared/sites/config.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { ProjectGitSnapshots } from "../../../project-content/git/snapshot.js";
import { placementAt } from "../../../project-content/placement-read.js";
import { placementCommitMessage } from "../../../project-content/placement-history.js";
import { DocumentError } from "../../errors.js";
import { documentAuthor } from "../commands.js";
import { documentIdentity, type DocumentFileProjects } from "../projects.js";
import { requireFileDocument } from "../source-access.js";
import { filePlacementCommand } from "./commands.js";
import { filePlacement, filePlacements, publicationSpace } from "./read.js";

/** Link policy runs under the project lease; retries return the original immutable link and destination changes commit together. */
export class FileDocumentPlacements implements ProjectDocumentPlacements {
  constructor(private readonly projects: DocumentFileProjects) {}
  get(projectId: string, id: string) {
    return this.projects.view(
      projectId,
      async (_project, view) => (await filePlacement(view, projectId, id)).placement,
    );
  }
  list(projectId: string, kind: "documentId" | "spaceId", id: string) {
    documentIdentity(id);
    if (!["documentId", "spaceId"].includes(kind)) throw new DocumentError("invalidInput");
    return this.projects.view(projectId, async (_project, view) => {
      if (kind === "documentId") await requireFileDocument(view, projectId, id);
      else await publicationSpace(view, projectId, id);
      return filePlacements(view, projectId, kind, id);
    });
  }
  history(projectId: string, id: string) {
    return this.projects.view(projectId, async (project, view) => {
      await filePlacement(view, projectId, id);
      return project.placements.historyIn(view, id);
    });
  }
  event(projectId: string, id: string, version: number) {
    if (!Number.isSafeInteger(version) || version < 1) throw new DocumentError("invalidInput");
    return this.projects.view(projectId, async (project, view) => {
      await filePlacement(view, projectId, id);
      return project.placements.eventIn(view, id, version);
    });
  }
  create(actor: string, projectId: string, value: unknown) {
    return this.execute(actor, projectId, null, "create", value);
  }
  update(actor: string, projectId: string, id: string, value: unknown) {
    return this.execute(actor, projectId, documentIdentity(id), "update", value);
  }
  remove(actor: string, projectId: string, id: string, value: unknown) {
    return this.execute(actor, projectId, documentIdentity(id), "remove", value);
  }
  private async execute(
    actor: string,
    projectId: string,
    selectedId: string | null,
    kind: "create" | "update" | "remove",
    value: unknown,
  ) {
    const command = filePlacementCommand(kind, value),
      id = command.ids?.id ?? selectedId!;
    return this.projects.write(projectId, async (project) => {
      const result = await project.coordinator.plan(
        {
          operationId: command.operationId,
          author: documentAuthor(actor),
          message: "Change project publication link",
          intent: stableJson({ schema: 1, kind: "publication-link", projectId, id, actor, command }),
        },
        async (view) => {
          const previous = kind === "create" ? null : (await filePlacement(view, projectId, id)).placement;
          if (previous && (previous.deletedAt !== null || previous.version !== command.version))
            throw new DocumentError("conflict", 409);
          const spaceId = command.ids?.spaceId ?? previous!.spaceId;
          const target = await project.spaces.read(view, spaceId);
          await publicationSpace(view, projectId, spaceId);
          if (target.space.version !== command.spaceVersion) throw new DocumentError("spaceConflict", 409);
          const documentId = command.ids?.documentId ?? previous!.documentId;
          let fields;
          if (kind === "remove")
            fields = {
              path: previous!.path,
              locale: previous!.locale,
              revisionId: previous!.revisionId,
              metadata: previous!.metadata,
            };
          else {
            const source = await requireFileDocument(view, projectId, documentId);
            if (source.spaceId === spaceId) throw new DocumentError("invalidPlacementTarget");
            const input = command.fields!,
              { revision } = await project.documents.selection(view, source, input.revisionId ?? source.revisionId);
            if (!compatibleDocumentLocale(revision.locale, input.locale))
              throw new DocumentError("placementLocaleMismatch", 409);
            const profile = target.sourceProfile;
            if (
              profile &&
              !Object.keys(profile.editions).some((locale) => locale.toLowerCase() === input.locale.toLowerCase())
            )
              throw new DocumentError("sourceEditionMissing");
            try {
              fields = { ...input, metadata: publicDocumentMetadata(input.metadata, profile?.metadataFields) };
            } catch (error) {
              if (error instanceof SiteProfileError) throw new DocumentError("invalidPlacementMetadata");
              throw error;
            }
          }
          const now = Math.max(Date.now(), previous?.updatedAt ?? 0),
            placement: DocumentPlacement = {
              id,
              projectId,
              documentId,
              spaceId,
              ...fields,
              version: (command.version ?? 0) + 1,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
              deletedAt: kind === "remove" ? now : null,
            },
            row = { schema: 1 as const, placement, audit: { operation: kind, actor, createdAt: now } };
          return {
            changes: await project.placements.prepare(view, row, command.version, command.spaceVersion),
            message: placementCommitMessage(row),
          };
        },
      );
      const original = await placementAt(new ProjectGitSnapshots(project.owned), result.commit, projectId, id);
      await this.projects.authorize(projectId);
      return original.placement;
    });
  }
}
