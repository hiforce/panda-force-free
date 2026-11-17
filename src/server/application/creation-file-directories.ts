import { CreationError } from "../creation/contracts.js";
import { creationCodeDirectories } from "../creation/integration/code-directories.js";
import type { ApplicationConfig } from "./types.js";
import type { ApplicationProjects } from "./projects.js";

/** Document membership alone does not grant a local member access to the shared host workspace. */
export function applicationCreationFileDirectories(
  config: ApplicationConfig,
  projects: ApplicationProjects,
  hostOwner: () => string | null,
  authorize: (owner: string, project: string) => Promise<void>,
) {
  return creationCodeDirectories({
    authorize: async (task) => {
      if (task.owner !== hostOwner()) throw new CreationError("notFound");
      await authorize(task.owner, task.projectId);
    },
    root: async (task) => {
      if (task.projectId === "personal") {
        if (!config.allowExternalDirectories) throw new CreationError("notFound");
        return config.defaultCwd;
      }
      const project = await projects.catalog.project(task.projectId);
      if (project.workspace?.state !== "ready") throw new CreationError("notFound");
      return project.workspace.path;
    },
  });
}
