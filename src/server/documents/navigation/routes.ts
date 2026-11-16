import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { auditPrincipal } from "../../auth/audit-principal.js";
import { documentRouteProtection as protect } from "../protection.js";
import { DocumentError } from "../errors.js";
import { MAX_DOCUMENT_BYTES, text } from "../validation.js";
import type { DocumentNavigationPort } from "./port.js";

/** Tree commands never configure an engine or publish content. Authentication is owned by the router. */
export function projectDocumentTreeRoutes(
  service: DocumentNavigationPort,
  principal: (context: RouteContext) => string = (context) => auditPrincipal(context.idaasSession?.identity),
): Route[] {
  return [
    {
      path: "/api/project-document-tree",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, await service.tree(text(url.searchParams.get("project"), 128))),
      ),
    },
    {
      path: "/api/project-document-tree/documents",
      method: "POST",
      handler: protect(async (context) =>
        respondJson(
          context.res,
          201,
          await service.create(principal(context), await readJsonBody(context.req, MAX_DOCUMENT_BYTES + 32768)),
        ),
      ),
    },
    {
      path: "/api/project-document-tree/actions",
      method: "POST",
      handler: protect(async (context) => {
        const { req, res } = context,
          { action, ...input } = await readJsonBody(req, 8192),
          owner = principal(context);
        switch (action) {
          case "move":
            return respondJson(res, 200, await service.move(owner, input));
          case "rename":
            return respondJson(res, 200, await service.rename(owner, input));
          case "trash":
            return respondJson(res, 200, await service.trash(owner, input));
          case "restore":
            return respondJson(res, 200, await service.restore(owner, input));
          default:
            throw new DocumentError("invalidInput");
        }
      }),
    },
    {
      path: "/api/project-document-tree/trash",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(
          res,
          200,
          await service.trashPage(
            text(url.searchParams.get("project"), 128),
            url.searchParams.get("cursor") ?? undefined,
          ),
        ),
      ),
    },
  ];
}
