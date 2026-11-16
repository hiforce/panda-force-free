import type { BuildExecutor } from "../../shared/builds/contracts.js";
import type { BuildAvailability } from "../../shared/builds/jobs.js";
import type { ResourceBuildRequest } from "../../shared/builds/resources.js";
import type { BuildExecution } from "../../shared/builds/contracts.js";

export interface SiteExecutor extends BuildExecutor {
  startResource?(id: string, input: ResourceBuildRequest): Promise<BuildExecution>;
  availability(): Promise<BuildAvailability>;
  logs(id: string): Promise<string>;
}
