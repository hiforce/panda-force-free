import type { BuildInput } from "../../shared/builds/contracts.js";
import type { BuildSourceRevision, SiteBuildRequest, SiteBuild } from "../../shared/builds/jobs.js";

export interface BuildSourceSnapshot {
  input: BuildInput;
  sources: BuildSourceRevision[];
  sourceSnapshot?: SiteBuild["sourceSnapshot"];
}
/** A snapshot contains only immutable saved revisions and authorized asset bytes. */
export interface BuildSources {
  authorize(spaceId: string, projectId?: string): void | Promise<void>;
  capture(request: SiteBuildRequest): Promise<BuildSourceSnapshot>;
}
