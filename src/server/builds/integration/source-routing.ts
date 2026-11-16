import type { BuildSources } from "../source-port.js";

/** Legacy jobs retain their original route; explicitly scoped jobs cannot cross storage backends on failure. */
export function routeProjectBuildSources(legacy: BuildSources, projects: BuildSources): BuildSources {
  return {
    authorize(spaceId, projectId) {
      return (projectId === undefined ? legacy : projects).authorize(spaceId, projectId);
    },
    capture(request) {
      return (request.projectId === undefined ? legacy : projects).capture(request);
    },
  };
}
