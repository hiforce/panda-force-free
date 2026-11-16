import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { packageRecord } from "../../../shared/plugins/validation.js";
import type { ChannelTemplateMetadataCatalog } from "../presentation-ports.js";
import type { PublicationFormat } from "../../../shared/publishing/content.js";
import { pluginRouteProtection } from "./protect.js";
import { renderStyleSample } from "./style-samples.js";
export function publishingStyleRoutes(
  templates: ChannelTemplateMetadataCatalog,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = pluginRouteProtection(owner);
  return [
    {
      path: "/api/publishing-styles/sample",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "version", "format"]);
        respondJson(
          res,
          200,
          await renderStyleSample(
            templates,
            input.id as string,
            input.version as string,
            input.format as PublicationFormat,
          ),
        );
      }),
    },
  ];
}
