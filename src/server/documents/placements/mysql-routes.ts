import type { Route } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { auditPrincipal } from "../../auth/audit-principal.js";
import { documentRouteProtection as protect } from "../protection.js";
import { DocumentError } from "../errors.js";
import { text } from "../validation.js";
import type { MySQLDocumentPlacements } from "./mysql-service.js";
/** HTTP expresses configuration intent only; it cannot start a build or publish a document. */
export function mysqlDocumentPlacementRoutes(service: MySQLDocumentPlacements): Route[] {
  return [
    {
      path: "/api/document-placements",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const { req, res, url } = context;
        if (req.method === "GET") {
          const documentId = url.searchParams.get("document"),
            spaceId = url.searchParams.get("space");
          if (Boolean(documentId) === Boolean(spaceId)) throw new DocumentError("invalidInput");
          return respondJson(res, 200, {
            placements: documentId
              ? await service.listForDocument(documentId)
              : await service.listForSpace(text(spaceId, 128)),
          });
        }
        const actor = auditPrincipal(context.idaasSession?.identity);
        respondJson(res, 201, { placement: await service.create(await readJsonBody(req, 64 * 1024), actor) });
      }),
    },
    {
      path: "/api/document-placements/detail",
      method: ["GET", "PUT", "DELETE"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          id = text(url.searchParams.get("id"), 128);
        if (req.method === "GET") return respondJson(res, 200, { placement: await service.get(id) });
        const actor = auditPrincipal(context.idaasSession?.identity),
          input = await readJsonBody(req, 64 * 1024);
        respondJson(res, 200, {
          placement:
            req.method === "PUT"
              ? await service.update(id, input, actor)
              : await service.remove(id, input.version, actor),
        });
      }),
    },
    {
      path: "/api/document-placements/history",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, { events: await service.history(text(url.searchParams.get("id"), 128)) }),
      ),
    },
  ];
}
