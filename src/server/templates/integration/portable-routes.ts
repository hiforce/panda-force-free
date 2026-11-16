import { templateManagementProtection } from "./protect.js";
import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { templateChoice, templateObject } from "../../../shared/templates/portable/validation.js";
import { PORTABLE_TEMPLATE_JSON_BYTES } from "../../../shared/templates/portable/bundle.js";
import { PortableRegistryError } from "../portable/errors.js";
import { PortableTemplateSource } from "../portable/source.js";
import type { PortableTemplateInstallation } from "../portable/installation.js";
import type { PortableTemplateInspectionPort } from "../portable/inspection.js";
import { RasterCoverRenderer, respondRasterCover } from "../../media/raster-cover.js";
export function portableTemplateRoutes(
  installation: PortableTemplateInstallation,
  inspection: PortableTemplateInspectionPort,
  owner: (context: RouteContext) => string,
  covers = new RasterCoverRenderer(),
): Route[] {
  const protect = templateManagementProtection(owner);
  const identity = (context: RouteContext): [string, string, string] => {
    const params = context.url.searchParams;
    if ([...params.keys()].some((key) => !["id", "version", "digest"].includes(key) || params.getAll(key).length !== 1))
      throw new PortableRegistryError("invalidInput");
    return [params.get("id")!, params.get("version")!, params.get("digest")!];
  };
  const upload = (content: unknown, name: unknown) => {
    if (typeof content !== "string" || content.length > PORTABLE_TEMPLATE_JSON_BYTES)
      throw new PortableRegistryError("invalidInput");
    return PortableTemplateSource.read(new TextEncoder().encode(content), name);
  };
  return [
    {
      path: "/api/templates/cover",
      method: "GET",
      handler: protect(async (context) => {
        const bytes = await inspection.artwork(...identity(context));
        respondRasterCover(context.req, context.res, await covers.render(bytes));
      }),
    },
    {
      path: "/api/templates/detail",
      method: "GET",
      handler: protect(async (context) => respondJson(context.res, 200, await inspection.detail(...identity(context)))),
    },
    {
      path: "/api/templates/preview",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(context.res, 200, await inspection.preview(...identity(context))),
      ),
    },
    {
      path: "/api/templates/export",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(
          context.res,
          200,
          JSON.parse(new TextDecoder().decode(await inspection.export(...identity(context)))),
        ),
      ),
    },
    {
      path: "/api/templates/review",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = templateObject(await readJsonBody(req, 2 * PORTABLE_TEMPLATE_JSON_BYTES + 8192), [
          "content",
          "name",
          "selected",
        ]);
        respondJson(res, 200, await installation.review(await upload(input.content, input.name), input.selected));
      }),
    },
    {
      path: "/api/templates/install",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = templateObject(await readJsonBody(req, 2 * PORTABLE_TEMPLATE_JSON_BYTES + 65536), [
          "content",
          "name",
          "approval",
        ]);
        respondJson(
          res,
          201,
          await installation.install(await upload(input.content, input.name), input.approval, actor),
        );
      }),
    },
    {
      path: "/api/templates/state",
      method: "PUT",
      handler: protect(async ({ req, res }, actor) => {
        const input = templateObject(await readJsonBody(req, 4096), [
          "id",
          "version",
          "digest",
          "action",
          "expectedRevision",
        ]);
        respondJson(
          res,
          200,
          await inspection.state(
            input.id as string,
            input.version as string,
            input.digest as string,
            templateChoice(input.action, ["enable", "disable", "activate"]),
            input.expectedRevision as number,
            actor,
          ),
        );
      }),
    },
  ];
}
