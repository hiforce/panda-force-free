import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";
import { templateManagementProtection } from "./protect.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { TemplateDraftAuthoringPort } from "../authoring/service.js";
export function templateDraftRoutes(
  service: TemplateDraftAuthoringPort,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = templateManagementProtection(owner),
    bodyLimit = 3 * 1024 * 1024 + 16384;
  const command = (kind: "create" | "fork" | "save" | "remove") =>
    protect(async ({ req, res }, actor) =>
      respondJson(
        res,
        kind === "create" || kind === "fork" ? 201 : 200,
        await service.execute(actor, kind, await readJsonBody(req, bodyLimit)),
      ),
    );
  return [
    {
      path: "/api/template-drafts",
      method: ["GET", "POST", "PUT", "DELETE"],
      handler: protect(async ({ req, res, url }, actor) => {
        if ([...url.searchParams].length) throw new PortableRegistryError("invalidInput");
        if (req.method === "GET") return respondJson(res, 200, await service.list(actor));
        const kind = req.method === "POST" ? "create" : req.method === "PUT" ? "save" : "remove";
        respondJson(
          res,
          kind === "create" ? 201 : 200,
          await service.execute(actor, kind, await readJsonBody(req, bodyLimit)),
        );
      }),
    },
    {
      path: "/api/template-drafts/detail",
      method: "GET",
      handler: protect(async ({ res, url }, actor) => {
        if ([...url.searchParams.keys()].some((key) => key !== "id") || url.searchParams.getAll("id").length !== 1)
          throw new PortableRegistryError("invalidInput");
        respondJson(res, 200, await service.detail(actor, url.searchParams.get("id")!));
      }),
    },
    { path: "/api/template-drafts/fork", method: "POST", handler: command("fork") },
    {
      path: "/api/template-drafts/review",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = templateObject(await readJsonBody(req, 4096), ["id", "revision", "digest"]);
        respondJson(
          res,
          200,
          await service.review(actor, input.id as string, input.revision as number, input.digest as string),
        );
      }),
    },
    {
      path: "/api/template-drafts/publish",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = templateObject(await readJsonBody(req, 16384), ["id", "revision", "digest", "approval"]);
        respondJson(
          res,
          201,
          await service.publish(
            actor,
            input.id as string,
            input.revision as number,
            input.digest as string,
            input.approval,
          ),
        );
      }),
    },
  ];
}
