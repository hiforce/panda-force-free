import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { templateManagementProtection } from "./protect.js";
import type { SourceTemplateImport } from "../sources/import.js";

export function sourceTemplateImportRoutes(
  service: SourceTemplateImport,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = templateManagementProtection(owner);
  return ["review", "install"].map((action): Route => ({
    path: `/api/templates/from-source/${action}`,
    method: "POST",
    handler: protect(async ({ req, res }, actor) => {
      const input = await readJsonBody(req, 128 * 1024);
      respondJson(
        res,
        action === "install" ? 201 : 200,
        await (action === "install" ? service.install(actor, input) : service.review(actor, input)),
      );
    }),
  }));
}
