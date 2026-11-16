import type { Route } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { EditorialService } from "../service.js";
import { editorialField as field, editorialOwner as owner, protectEditorial as protect } from "./protect.js";

export function editorialRoutes(
  service: Pick<EditorialService, "history" | "list" | "prepare" | "detail" | "accept">,
): Route[] {
  return [
    {
      path: "/api/document-editorial/history",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(
          context.res,
          200,
          await service.history(
            owner(context),
            field(context.url.searchParams.get("document")),
            context.url.searchParams.get("before"),
            context.url.searchParams.get("project") ?? undefined,
          ),
        ),
      ),
    },
    {
      path: "/api/document-editorial",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        if (context.req.method === "GET")
          return respondJson(context.res, 200, {
            proposals: await service.list(
              owner(context),
              field(context.url.searchParams.get("document")),
              context.url.searchParams.get("project") ?? undefined,
            ),
          });
        respondJson(context.res, 201, await service.prepare(owner(context), await readJsonBody(context.req, 8192)));
      }),
    },
    {
      path: "/api/document-editorial/detail",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(context.res, 200, await service.detail(owner(context), field(context.url.searchParams.get("id")))),
      ),
    },
    {
      path: "/api/document-editorial/accept",
      method: "POST",
      handler: protect(async (context) =>
        respondJson(context.res, 200, {
          receipt: await service.accept(owner(context), await readJsonBody(context.req, 65536)),
        }),
      ),
    },
  ];
}
