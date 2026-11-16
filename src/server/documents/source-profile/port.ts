import type {
  SourceConfigurationOptions,
  SourceConfigurationProposal,
  SiteSourceProfile,
  SiteEdition,
} from "../../../shared/sites/profile.js";
import type { SourceResourceFile } from "./resources.js";

/** Profile inspection is read-only and scoped independently from source saving and build execution. */
export interface ProjectSourceProfiles {
  options(projectId: string, spaceId: string): Promise<SourceConfigurationOptions>;
  inspect(
    projectId: string,
    spaceId: string,
    locale: string,
    files: string[],
    webp: boolean,
  ): Promise<SourceConfigurationProposal>;
}
export interface ProjectSourceProfileCapture {
  capture(
    projectId: string,
    spaceId: string,
    locale: string,
    expectedSpaceVersion?: number,
  ): Promise<{
    projectId: string;
    spaceId: string;
    spaceVersion: number;
    commit: string;
    profile: SiteSourceProfile;
    edition: SiteEdition;
    files: SourceResourceFile[];
  } | null>;
}
