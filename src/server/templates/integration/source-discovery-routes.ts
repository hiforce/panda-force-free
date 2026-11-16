import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { sourceRouteProtection } from "../../package-sources/protect.js";
import { stageId } from "../../../shared/packages/stages/input.js";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";
import type { TemplateSourceDiscovery } from "../sources/discovery.js";

export function templateSourceDiscoveryRoutes(
  discovery: TemplateSourceDiscovery,
  owner: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/templates/source-discovery",
      method: "GET",
      handler: sourceRouteProtection(owner)(async (context, actor) => {
        if (
          [...context.url.searchParams.keys()].some((key) => key !== "id") ||
          context.url.searchParams.getAll("id").length !== 1
        )
          throw new SourceStageError("stageInvalidInput");
        respondJson(context.res, 200, await discovery.inspect(actor, stageId(context.url.searchParams.get("id"))));
      }),
    },
  ];
}
