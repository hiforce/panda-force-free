import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson, respondReadJson } from "../http/respond.js";
import { matchesRequestOrigin } from "../auth/origin.js";
import { errorPayload } from "../i18n/error-payload.js";
import { SkillWorkspaceError } from "../../shared/skill-workspace.js";
import type { SkillWorkspaceService } from "./service.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";

export function skillWorkspaceRoutes(
  service: SkillWorkspaceService,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect =
    (run: (context: RouteContext, actor: string) => Promise<void> | void): Route["handler"] =>
    async (context) => {
      let actor: string;
      try {
        actor = owner(context);
      } catch {
        return respondJson(context.res, 403, errorPayload("plugins.identityRequired"));
      }
      if (
        context.req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: context.req.headers.host,
          origin: context.req.headers.origin,
          fetchSite: context.req.headers["sec-fetch-site"],
        })
      )
        return respondJson(context.res, 403, errorPayload("plugins.identityRequired"));
      try {
        await run(context, actor);
      } catch (error) {
        if (error instanceof SkillWorkspaceError)
          return respondJson(
            context.res,
            error.code === "conflict"
              ? 409
              : ["categoryMissing", "skillUnavailable"].includes(error.code)
                ? 404
                : error.code === "invalidInput"
                  ? 400
                  : 503,
            { ...errorPayload(`skillWorkspace.${error.code}`), code: error.code },
          );
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("skillWorkspace.invalidInput"));
        reportDiagnostic("skill-workspace", error);
        respondJson(context.res, 503, errorPayload("skillWorkspace.unavailable"));
      }
    };
  return [
    {
      path: "/api/skill-workspace",
      method: "GET",
      handler: protect(async ({ url, req, res }, actor) => {
        if (
          [...url.searchParams.keys()].some((key) => key !== "view") ||
          url.searchParams.getAll("view").length > 1 ||
          (url.searchParams.has("view") && url.searchParams.get("view") !== "categories")
        )
          throw new SkillWorkspaceError("invalidInput");
        const started = performance.now();
        const snapshot = await service.snapshot(actor, url.searchParams.get("view") === "categories");
        res.setHeader("Server-Timing", `skill-workspace;dur=${(performance.now() - started).toFixed(2)}`);
        respondReadJson(req, res, 200, snapshot);
      }),
    },
    {
      path: "/api/skill-workspace/commands",
      method: "POST",
      handler: protect(async ({ url, req, res }, actor) => {
        if (url.search) throw new SkillWorkspaceError("invalidInput");
        respondJson(res, 200, await service.change(actor, await readJsonBody(req, 128 * 1024)));
      }),
    },
    {
      path: "/api/skill-workspace/skill",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if ([...url.searchParams.keys()].some((key) => key !== "key") || url.searchParams.getAll("key").length !== 1)
          throw new SkillWorkspaceError("invalidInput");
        respondJson(res, 200, await service.skill(actor, url.searchParams.get("key")));
      }),
    },
  ];
}
