import type { Route, RouteContext } from "../../http/router.js";
import type { SiteSampleServicePort } from "../site-sample-service.js";
import type { SiteBuildArtifacts } from "../../builds/artifacts.js";
import { staticSiteSampleRoutes } from "../../builds/integration/sample-routes.js";
import { pluginRouteProtection } from "./protect.js";

/** Legacy samples keep their actor placement and validation behind the shared static HTTP adapter. */
export function siteSampleRoutes(
  service: SiteSampleServicePort,
  artifacts: SiteBuildArtifacts,
  owner: (context: RouteContext) => string,
): Route[] {
  return staticSiteSampleRoutes(
    "/api/site-samples",
    {
      lookup: (actor, source) => service.lookup(source, actor),
      start: (actor, value) => service.start(value, actor),
      list: (actor) => service.list(actor),
      detail: (actor, id) => service.detail(id, actor),
      logs: (actor, id) => service.logs(id, actor),
      cancel: (actor, id) => service.cancel(id, actor),
      requireArtifact: (actor, id) => service.requireArtifact(id, actor),
      remove: (actor, id) => service.remove(id, actor),
    },
    artifacts,
    pluginRouteProtection(owner),
  );
}
