import type { MetadataStore } from "../../../shared/async-value.js";
import type { SiteBuildService } from "../../builds/service.js";
import type { DocumentService } from "../../documents/service.js";
import type { ProjectDocumentSpaces } from "../../documents/space-port.js";
import { DeliveryError } from "../errors.js";
import type { PublicationSources } from "../ports.js";
import { publicationAccess } from "./source-access.js";
/** File protections re-read native ownership before each effect; no synchronous SQL adapter is involved. */
export function mysqlPublicationSources(
  builds: Pick<SiteBuildService, "publicationSnapshot">,
  documents: {
    spaces: MetadataStore<Pick<DocumentService["spaces"], "get">>;
    listSpaces: MetadataStore<Pick<DocumentService, "listSpaces">>["listSpaces"];
  },
  projects: { spaces: Pick<ProjectDocumentSpaces, "get">; requireProject(id: string): unknown },
  roots: () => Promise<string[]>,
): PublicationSources {
  const authorize: PublicationSources["authorize"] = async (id, projectId) => {
    const space =
      projectId === undefined ? await documents.spaces.get(id) : (await projects.spaces.get(projectId, id)).space;
    if (projectId !== undefined && space.projectId !== projectId) throw new DeliveryError("notFound", 404);
    const assertCurrent = async () => {
      if (projectId === undefined) {
        await documents.listSpaces(space.projectId);
        if ((await documents.spaces.get(id)).projectId !== space.projectId) throw new DeliveryError("notFound", 404);
      } else await projects.requireProject(projectId);
    };
    await assertCurrent();
    return {
      assertCurrent,
      async assertDestination(path) {
        await assertCurrent();
        publicationAccess(() => {}, [space.sourceRoot, ...(await roots())]).assertDestination(path);
      },
    };
  };
  return {
    authorize,
    async capture(id, owner) {
      const { build, artifact } = await builds.publicationSnapshot(id, owner);
      if (build.projectId !== undefined && build.sourceSnapshot?.projectId !== build.projectId)
        throw new DeliveryError("sourceUnavailable", 409);
      await (await authorize(build.spaceId, build.projectId)).assertCurrent();
      const projectId = build.projectId ?? (await documents.spaces.get(build.spaceId)).projectId;
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
