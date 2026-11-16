import { siteSourceProfile, sourceLocale } from "../../../shared/sites/profile.js";
import { SiteProfileError } from "../../../shared/sites/config.js";
import type { MySQLSpaceRepository } from "../mysql-space-repository.js";
import type { DocumentSourceReader } from "../source-reader.js";
import { DocumentError } from "../errors.js";
import { expectedVersion } from "../validation.js";
import type { MySQLSourceProfileRepository } from "./mysql-repository.js";
import { inspectSourceConfiguration, sourceConfigurationOptions } from "./inspection.js";
import { proposedSourceProfile } from "./proposal.js";
import { sourceResourceFiles } from "./resources.js";
export class MySQLDocumentSourceProfiles {
  constructor(
    private spaces: MySQLSpaceRepository,
    private sources: DocumentSourceReader,
    private profiles: MySQLSourceProfileRepository,
    private requireProject: (id: string) => unknown,
  ) {}
  private async space(id: string) {
    const space = await this.spaces.get(id);
    await this.requireProject(space.projectId);
    return space;
  }
  async get(id: string) {
    await this.space(id);
    return await this.profiles.get(id);
  }
  async save(id: string, value: unknown, version: unknown) {
    const space = await this.space(id);
    try {
      const profile = siteSourceProfile(value);
      if (profile.engine !== space.engine || (space.sourceMode === "managed" && profile.resources.length))
        throw new SiteProfileError("invalidProfile");
      return await this.profiles.put(id, profile, expectedVersion(version));
    } catch (error) {
      if (error instanceof SiteProfileError) throw new DocumentError("invalidSourceConfiguration");
      throw error;
    }
  }
  async options(id: string) {
    const space = await this.space(id);
    if (space.sourceMode !== "external" || space.engine !== "hexo") throw new DocumentError("invalidInput");
    return sourceConfigurationOptions(await this.sources.root(space.sourceRoot));
  }
  async inspect(id: string, locale: string, files: string[], webp: boolean) {
    const space = await this.space(id);
    if (space.engine !== "hexo" || space.sourceMode !== "external") throw new DocumentError("invalidInput");
    sourceLocale(locale);
    const root = await this.sources.root(space.sourceRoot),
      options = await sourceConfigurationOptions(root),
      proposal = await inspectSourceConfiguration(root, files),
      prior = await this.profiles.get(id);
    const profile = proposedSourceProfile(prior, options, proposal.edition, locale, webp);
    if ((await this.spaces.get(id)).version !== space.version) throw new DocumentError("spaceConflict", 409);
    return { profile: siteSourceProfile(profile), omitted: proposal.omitted, spaceVersion: space.version };
  }
  async capture(id: string, locale: string) {
    const space = await this.space(id),
      profile = await this.profiles.get(id);
    if (!profile) return null;
    const edition = profile.editions[locale];
    if (!edition) throw new DocumentError("sourceEditionMissing");
    const files = profile.resources.length
      ? await sourceResourceFiles(await this.sources.root(space.sourceRoot), profile.resources)
      : [];
    if ((await this.spaces.get(id)).version !== space.version) throw new DocumentError("spaceConflict", 409);
    return { profile, edition, files };
  }
}
