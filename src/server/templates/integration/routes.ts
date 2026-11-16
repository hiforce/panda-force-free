import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { TemplateCatalogError } from "../errors.js";
import type { TemplateCatalog, TemplateCatalogQuery } from "../catalog.js";
import { SkillWorkspaceError } from "../../../shared/skill-workspace.js";

export function templateCatalogRoutes(
  catalog: TemplateCatalog,
  owner: (context: RouteContext) => string,
  collection?: (
    actor: string,
    id: string,
  ) =>
    | Pick<TemplateCatalogQuery, "categoryFilter" | "personalRevision" | "domain">
    | Promise<Pick<TemplateCatalogQuery, "categoryFilter" | "personalRevision" | "domain">>,
): Route[] {
  return [
    {
      path: "/api/template-catalog",
      method: "GET",
      async handler(context) {
        try {
          let actor: string;
          try {
            actor = owner(context);
          } catch {
            return respondJson(context.res, 403, errorPayload("plugins.identityRequired"));
          }
          const params = context.url.searchParams;
          if (
            [...params.keys()].some(
              (key) =>
                ![
                  "registry",
                  "view",
                  "type",
                  "category",
                  "state",
                  "search",
                  "cursor",
                  "limit",
                  "section",
                  "domain",
                  "engine",
                  "format",
                  "collection",
                  "order",
                ].includes(key),
            ) ||
            [...params.keys()].some((key) => params.getAll(key).length > 1)
          )
            throw new TemplateCatalogError("invalidQuery");
          const query: TemplateCatalogQuery = {};
          if (params.has("view")) query.view = params.get("view") as TemplateCatalogQuery["view"];
          if (params.has("order")) query.order = params.get("order") as TemplateCatalogQuery["order"];
          if (params.has("registry")) query.registry = params.get("registry") as TemplateCatalogQuery["registry"];
          if (params.has("section")) query.section = params.get("section") as TemplateCatalogQuery["section"];
          if (params.has("domain")) query.domain = params.get("domain") as TemplateCatalogQuery["domain"];
          for (const key of ["type", "category", "search", "cursor", "engine", "format"] as const)
            if (params.has(key)) query[key] = params.get(key)!;
          if (params.has("state")) query.state = params.get("state") as TemplateCatalogQuery["state"];
          if (params.has("limit")) query.limit = Number(params.get("limit"));
          if (params.has("collection")) {
            if (!collection) throw new TemplateCatalogError("invalidQuery");
            Object.assign(query, await collection(actor, params.get("collection")!));
          }
          respondJson(context.res, 200, await catalog.list(query, actor));
        } catch (error) {
          if (error instanceof SkillWorkspaceError)
            return respondJson(
              context.res,
              error.code === "categoryMissing" ? 404 : 400,
              errorPayload(`skillWorkspace.${error.code}`),
            );
          if (error instanceof TemplateCatalogError && error.code !== "unavailable")
            return respondJson(context.res, error.code === "invalidQuery" ? 400 : 409, {
              ...errorPayload(error.code === "invalidQuery" ? "plugins.invalidPackage" : "plugins.registryConflict"),
              code: error.code,
            });
          reportDiagnostic("template-catalog", error);
          respondJson(context.res, 503, errorPayload("plugins.packageUnavailable"));
        }
      },
    },
  ];
}
