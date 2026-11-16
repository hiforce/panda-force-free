import type { SourceConfigurationProposal } from "../../../../shared/sites/profile.js";
import { sourceLocale } from "../../../../shared/sites/profile.js";
import type { DocumentSourceReader } from "../../source-reader.js";
import { sourceConfigurationOptions, inspectSourceConfiguration } from "../../source-profile/inspection.js";
import { sourceResourceFiles } from "../../source-profile/resources.js";
import { proposedSourceProfile } from "../../source-profile/proposal.js";
import { DocumentError } from "../../errors.js";
import { localeText } from "../../validation.js";
import { documentIdentity, type DocumentFileProjects } from "../projects.js";
import type { ProjectSourceProfiles, ProjectSourceProfileCapture } from "../../source-profile/port.js";

/** External source IO stays outside the project lease; both boundaries recheck access and the captured space version. */
export class FileDocumentSourceProfiles implements ProjectSourceProfiles, ProjectSourceProfileCapture {
  constructor(
    private readonly projects: DocumentFileProjects,
    private readonly sources: Pick<DocumentSourceReader, "root">,
  ) {}
  private configuration(projectId: string, spaceId: string) {
    documentIdentity(spaceId);
    return this.projects.view(projectId, async (project, view) => ({
      ...(await project.spaces.read(view, spaceId)),
      commit: view.commit,
    }));
  }
  private async unchanged(projectId: string, spaceId: string, version: number) {
    const current = await this.configuration(projectId, spaceId);
    if (current.space.version !== version) throw new DocumentError("spaceConflict", 409);
  }
  async options(projectId: string, spaceId: string) {
    const { space } = await this.configuration(projectId, spaceId);
    if (space.sourceMode !== "external" || space.engine !== "hexo") throw new DocumentError("invalidInput");
    const options = await sourceConfigurationOptions(await this.sources.root(space.sourceRoot));
    await this.unchanged(projectId, spaceId, space.version);
    return options;
  }
  async inspect(
    projectId: string,
    spaceId: string,
    locale: string,
    selected: string[],
    webp: boolean,
  ): Promise<SourceConfigurationProposal> {
    sourceLocale(locale);
    if (!Array.isArray(selected) || selected.some((file) => typeof file !== "string") || typeof webp !== "boolean")
      throw new DocumentError("invalidInput");
    const files = [...selected],
      { space, sourceProfile } = await this.configuration(projectId, spaceId);
    if (space.sourceMode !== "external" || space.engine !== "hexo") throw new DocumentError("invalidInput");
    const root = await this.sources.root(space.sourceRoot),
      options = await sourceConfigurationOptions(root),
      proposal = await inspectSourceConfiguration(root, files);
    const profile = proposedSourceProfile(sourceProfile, options, proposal.edition, locale, webp);
    await this.unchanged(projectId, spaceId, space.version);
    return { profile, omitted: proposal.omitted, spaceVersion: space.version };
  }
  async capture(projectId: string, spaceId: string, locale: string, expectedSpaceVersion?: number) {
    locale = localeText(locale);
    if (expectedSpaceVersion !== undefined && (!Number.isSafeInteger(expectedSpaceVersion) || expectedSpaceVersion < 1))
      throw new DocumentError("invalidInput");
    const { space, sourceProfile: profile, commit } = await this.configuration(projectId, spaceId);
    if (expectedSpaceVersion !== undefined && expectedSpaceVersion !== space.version)
      throw new DocumentError("spaceConflict", 409);
    if (!profile) return null;
    const edition = Object.entries(profile.editions).find(([key]) => key.toLowerCase() === locale.toLowerCase())?.[1];
    if (!edition) throw new DocumentError("sourceEditionMissing");
    const files = profile.resources.length
      ? await sourceResourceFiles(await this.sources.root(space.sourceRoot), profile.resources)
      : [];
    await this.unchanged(projectId, spaceId, space.version);
    return { projectId, spaceId, spaceVersion: space.version, commit, profile, edition, files };
  }
}
