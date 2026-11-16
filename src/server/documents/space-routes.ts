import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection as protect } from "./protection.js";
import { text } from "./validation.js";
import type { ProjectDocumentSpaces } from "./space-port.js";

export function projectDocumentSpaceRoutes(
  spaces: ProjectDocumentSpaces,
  principal: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/project-document-spaces",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const { req, res, url } = context;
        if (req.method === "GET")
          return respondJson(res, 200, { spaces: await spaces.list(text(url.searchParams.get("project"), 128)) });
        respondJson(res, 201, { space: await spaces.create(principal(context), await readJsonBody(req, 8192)) });
      }),
    },
    {
      path: "/api/project-document-spaces/detail",
      method: ["GET", "PUT"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          projectId = text(url.searchParams.get("project"), 128),
          spaceId = text(url.searchParams.get("id"), 128);
        respondJson(
          res,
          200,
          req.method === "GET"
            ? await spaces.get(projectId, spaceId)
            : await spaces.configure(principal(context), projectId, spaceId, await readJsonBody(req, 128 * 1024)),
        );
      }),
    },
    {
      path: "/api/project-document-spaces/inspect",
      method: "POST",
      handler: protect(async ({ req, res, url }) =>
        respondJson(
          res,
          200,
          await spaces.inspect(text(url.searchParams.get("project"), 128), await readJsonBody(req, 8192)),
        ),
      ),
    },
  ];
}
