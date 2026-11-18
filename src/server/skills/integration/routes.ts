import type { Route, RouteContext } from "../../http/router.js";
import { respondJson, respondReadJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import type { SkillCatalog } from "../catalog/service.js";
import { SkillRegistryError } from "../errors.js";
import { availableInstalledSkill } from "../../../shared/skills/availability.js";

export function skillCatalogRoutes(catalog: SkillCatalog, owner: (context: RouteContext) => string): Route[] {
  const handler =
    (activeOnly: boolean): Route["handler"] =>
    async (context) => {
      try {
        try {
          owner(context);
        } catch {
          return respondJson(context.res, 403, errorPayload("skills.identityRequired"));
        }
        const { url } = context,
          limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 10,
          view = url.searchParams.get("view");
        if (view !== null && view !== "available") throw new SkillRegistryError("invalidInput");
        const availableOnly = activeOnly || view === "available",
          started = performance.now(),
          page = await catalog.list(url.searchParams.get("cursor") ?? undefined, limit, availableOnly);
        context.res.setHeader("Server-Timing", `skill-catalog;dur=${(performance.now() - started).toFixed(2)}`);
        if (!activeOnly)
          return respondReadJson(context.req, context.res, 200, {
            ...page,
            packages: availableOnly
              ? page.packages.filter((pack) =>
                  pack.manifest.skills.some((skill) => availableInstalledSkill(pack, skill)),
                )
              : page.packages,
          });
        const skills = page.packages.flatMap((pack) =>
          pack.manifest.skills
            .filter((skill) => availableInstalledSkill(pack, skill))
            .map((skill) => ({
              packageId: pack.id,
              version: pack.version,
              digest: pack.digest,
              origin: pack.origin,
              ...skill,
            })),
        );
        respondReadJson(context.req, context.res, 200, {
          revision: page.revision,
          skills,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        if (error instanceof SkillRegistryError && error.code === "invalidInput")
          return respondJson(context.res, 400, { ...errorPayload("skills.invalidInput"), code: error.code });
        reportDiagnostic("skill-catalog-api", error);
        respondJson(context.res, 503, errorPayload("skills.unavailable"));
      }
    };
  return [
    { path: "/api/skill-packs", method: "GET", handler: handler(false) },
    { path: "/api/skills", method: "GET", handler: handler(true) },
  ];
}
