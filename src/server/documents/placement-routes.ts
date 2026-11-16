import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection as protect } from "./protection.js";
import { text } from "./validation.js";
import { DocumentError } from "./errors.js";
import type { ProjectDocumentPlacements } from "./placement-port.js";

export function projectDocumentPlacementRoutes(
  placements: ProjectDocumentPlacements,
  principal: (context: RouteContext) => string,
): Route[] {
  const scope = (url: URL) =>
    [text(url.searchParams.get("project"), 128), text(url.searchParams.get("id"), 128)] as const;
  return [
    {
      path: "/api/project-document-placements",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          projectId = text(url.searchParams.get("project"), 128);
        if (req.method === "POST")
          return respondJson(res, 201, {
            placement: await placements.create(principal(context), projectId, await readJsonBody(req, 65536)),
          });
        const documentId = url.searchParams.get("document"),
          spaceId = url.searchParams.get("space");
        if (Boolean(documentId) === Boolean(spaceId)) throw new DocumentError("invalidInput");
        respondJson(res, 200, {
          placements: await placements.list(
            projectId,
            documentId ? "documentId" : "spaceId",
            text(documentId ?? spaceId, 128),
          ),
        });
      }),
    },
    {
      path: "/api/project-document-placements/detail",
      method: ["GET", "PUT", "DELETE"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          [projectId, id] = scope(url);
        if (req.method === "GET") return respondJson(res, 200, { placement: await placements.get(projectId, id) });
        const actor = principal(context),
          input = await readJsonBody(req, 65536);
        respondJson(res, 200, {
          placement: await (req.method === "PUT"
            ? placements.update(actor, projectId, id, input)
            : placements.remove(actor, projectId, id, input)),
        });
      }),
    },
    {
      path: "/api/project-document-placements/history",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const selected = url.searchParams.get("version");
        respondJson(
          res,
          200,
          selected === null
            ? { events: await placements.history(...scope(url)) }
            : { event: await placements.event(...scope(url), Number(selected)) },
        );
      }),
    },
  ];
}
