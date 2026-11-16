import { mapMetadata, metadataFailure, type MetadataStore } from "../../../shared/async-value.js";
import type { DocumentSpace, DocumentAsset } from "../../../shared/documents/contracts.js";
import type { SiteThemeCatalog } from "../../../shared/presentation/themes.js";
import { documentBuildTheme } from "./document-theme.js";
import { projectDocumentBuild } from "./document-projection.js";
import { freezeBuildTheme } from "../../../shared/builds/theme.js";
import { DocumentError } from "../../documents/errors.js";
import type { BuildSources } from "../source-port.js";
import { SiteBuildError } from "../errors.js";
import type { SiteThemeDescriptor } from "../../../shared/presentation/themes.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import type { DocumentSourceProfiles } from "../../documents/source-profile/service.js";
import type { DocumentSpaceSnapshotPort } from "../../documents/space-snapshot.js";

/** The bridge is the only build module that knows document repositories and their access policy. */
export function documentBuildSources(options: {
  service: {
    spaces: { get(id: string): DocumentSpace | Promise<DocumentSpace> };
    listSpaces(project: string): unknown;
    themes: MetadataStore<SiteThemeCatalog>;
  };
  assets: {
    repository: { get(id: string): DocumentAsset | Promise<DocumentAsset> };
    content(id: string): Promise<{ asset: DocumentAsset; bytes: Buffer }>;
  };
  snapshots: MetadataStore<DocumentSpaceSnapshotPort>;
  captureTheme?: (theme: SiteThemeDescriptor) => Promise<BuildThemeSnapshot>;
  profiles?: Pick<DocumentSourceProfiles, "capture">;
}): BuildSources {
  const { service, assets, snapshots, profiles, captureTheme = freezeBuildTheme } = options;
  function authorize(spaceId: string) {
    return metadataFailure(
      () =>
        mapMetadata(service.spaces.get(spaceId), (space) => mapMetadata(service.listSpaces(space.projectId), () => {})),
      (error) => {
        if (error instanceof DocumentError) throw new SiteBuildError("notFound", error.status);
        throw error;
      },
    );
  }
  return {
    authorize,
    async capture(request) {
      await authorize(request.spaceId);
      let snapshot;
      try {
        snapshot = await snapshots.capture(request.spaceId, request.locale, {
          documents: 500,
          bytes: 16 * 1024 * 1024,
        });
      } catch (error) {
        if (error instanceof DocumentError)
          throw new SiteBuildError(error.code === "tooLarge" ? "snapshotTooLarge" : error.code, error.status);
        throw error;
      }
      const { space, documents: records } = snapshot;
      if (request.spaceVersion !== undefined && request.spaceVersion !== space.version)
        throw new SiteBuildError("spaceSettingsChanged", 409);
      if (!records.length) throw new SiteBuildError("emptyDocuments");
      const theme = request.nativeTheme
          ? null
          : await documentBuildTheme(space.theme, request.engine, service.themes, captureTheme),
        profile = await profiles?.capture(space.id, request.locale),
        captured = await projectDocumentBuild(request, snapshot, theme, profile, {
          metadata: (id) => assets.repository.get(id),
          content: (id) => assets.content(id),
        });
      if ((await service.spaces.get(space.id)).version !== space.version)
        throw new SiteBuildError("spaceSettingsChanged", 409);
      return captured;
    },
  };
}
