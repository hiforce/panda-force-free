import type { SiteBuildService } from "../../builds/service.js";
import type { DocumentService } from "../../documents/service.js";
import type { ProjectDocumentSpaces } from "../../documents/space-port.js";
import type { PublicationSources } from "../ports.js";
import { DeliveryError } from "../errors.js";
import { publicationAccess } from "./source-access.js";

export function publicationSources(
  builds: Pick<SiteBuildService, "publicationSnapshot">,
  documents: { spaces: Pick<DocumentService["spaces"], "get">; listSpaces: DocumentService["listSpaces"] },
  projects: { spaces: Pick<ProjectDocumentSpaces, "get">; requireProject: (id: string) => unknown },
): PublicationSources {
  const authorize: PublicationSources["authorize"] = async (id, projectId) => {
    if (projectId === undefined) {
      const space = documents.spaces.get(id);
      const access = publicationAccess(() => {
        documents.listSpaces(space.projectId);
        if (documents.spaces.get(id).projectId !== space.projectId) throw new DeliveryError("notFound", 404);
      }, [space.sourceRoot]);
      access.assertCurrent();
      return access;
    }
    const { space } = await projects.spaces.get(projectId, id);
    if (space.projectId !== projectId) throw new DeliveryError("notFound", 404);
    const access = publicationAccess(() => {
      projects.requireProject(projectId);
    }, [space.sourceRoot]);
    access.assertCurrent();
    return access;
  };
  return {
    authorize,
    async capture(id, ownerId) {
      const { build, artifact } = await builds.publicationSnapshot(id, ownerId);
      if (build.projectId !== undefined && build.sourceSnapshot?.projectId !== build.projectId)
        throw new DeliveryError("sourceUnavailable", 409);
      (await authorize(build.spaceId, build.projectId)).assertCurrent();
      const projectId = build.projectId ?? documents.spaces.get(build.spaceId).projectId;
      return {
        projectId,
        ...(build.projectId === undefined ? {} : { sourceProjectId: build.projectId }),
        spaceId: build.spaceId,
        artifact,
        build: {
          id: build.id,
          site: build.site,
          engine: build.engine,
          inputHash: build.inputHash,
          sources: build.sources,
          image: build.image,
          ...(build.sourceSnapshot === undefined ? {} : { sourceSnapshot: build.sourceSnapshot }),
        },
      };
    },
  };
}
