import type { BuildInput } from "../../shared/builds/contracts.js";
import type { SiteBuild, SiteBuildRequest, BuildSourceRevision } from "../../shared/builds/jobs.js";
import type { BuildRunChanges } from "../../shared/builds/run.js";
import type { BuildRunStore, LegacyBuildRunInputs, BuildRetentionStore } from "./runtime/ports.js";
export type BuildMutation = <T>(work: () => Promise<T>) => Promise<T>;

/** The build application and shared monitor consume records without choosing database or file adapters. */
export interface SiteBuildJobs extends BuildRunStore, LegacyBuildRunInputs, BuildRetentionStore {
  existing(request: SiteBuildRequest, actor?: string): SiteBuild | null;
  create(
    request: SiteBuildRequest,
    input: BuildInput,
    sources: BuildSourceRevision[],
    snapshot?: SiteBuild["sourceSnapshot"],
  ): SiteBuild;
  get(id: string): SiteBuild;
  update(id: string, changes: BuildRunChanges): SiteBuild;
  list(spaceId: string, before?: number, projectId?: string): SiteBuild[];
  logs(id: string): string;
  remove(id: string): void;
}
