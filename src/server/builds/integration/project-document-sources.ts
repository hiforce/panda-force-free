import type { MetadataStore } from "../../../shared/async-value.js";
import type { BuildSources } from "../source-port.js";
import type { ProjectDocumentAssets } from "../../documents/asset-port.js";
import type { ProjectDocumentSpaces } from "../../documents/space-port.js";
import type { ProjectDocumentSnapshots } from "../../documents/snapshot-port.js";
import type { ProjectSourceProfileCapture } from "../../documents/source-profile/port.js";
import type { SiteThemeCatalog, SiteThemeDescriptor } from "../../../shared/presentation/themes.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import { DocumentError } from "../../documents/errors.js";
import { SiteBuildError } from "../errors.js";
import { documentBuildTheme } from "./document-theme.js";
import { projectDocumentBuild } from "./document-projection.js";

/** Explicit project scope opens the file application; it never searches another project or falls back to legacy sources. */
export function projectDocumentBuildSources(options: {
  spaces: Pick<ProjectDocumentSpaces, "get">;
  snapshots: ProjectDocumentSnapshots;
  profiles: ProjectSourceProfileCapture;
  assets: Pick<ProjectDocumentAssets, "content" | "metadata">;
  themes: MetadataStore<SiteThemeCatalog>;
  captureTheme?: (theme: SiteThemeDescriptor) => Promise<BuildThemeSnapshot>;
}): BuildSources {
  function projectScope(projectId: string | undefined) {
    if (typeof projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId))
      throw new SiteBuildError("invalidInput");
    return projectId;
  }
  async function authorized(spaceId: string, scope?: string) {
    const projectId = projectScope(scope),
      { space } = await options.spaces.get(projectId, spaceId);
    if (space.projectId !== projectId) throw new SiteBuildError("notFound", 404);
  }
  return {
    authorize: authorized,
    async capture(request) {
      const projectId = projectScope(request.projectId);
      try {
        const snapshot = await options.snapshots.capture(
          projectId,
          request.spaceId,
          request.locale,
          { documents: 500, bytes: 16 * 1024 * 1024 },
          request.spaceVersion,
        );
        if (!snapshot.documents.length) throw new SiteBuildError("emptyDocuments");
        const { space } = snapshot,
          theme = request.nativeTheme
            ? null
            : await documentBuildTheme(space.theme, request.engine, options.themes, options.captureTheme),
          profile = await options.profiles.capture(projectId, space.id, request.locale, space.version),
          result = await projectDocumentBuild(request, snapshot, theme, profile, {
            metadata: (id) => options.assets.metadata(projectId, id),
            async content(id) {
              const content = await options.assets.content(projectId, id);
              return { asset: content.asset, bytes: Buffer.from(content.bytes) };
            },
          });
        const current = await options.spaces.get(projectId, space.id);
        if (current.space.version !== space.version) throw new SiteBuildError("spaceSettingsChanged", 409);
        return { ...result, sourceSnapshot: { projectId, commit: snapshot.commit, spaceVersion: space.version } };
      } catch (error) {
        if (error instanceof DocumentError)
          throw new SiteBuildError(
            error.code === "tooLarge"
              ? "snapshotTooLarge"
              : error.code === "spaceConflict"
                ? "spaceSettingsChanged"
                : error.code,
            error.status,
          );
        throw error;
      }
    },
  };
}
