import type { Route, RouteContext } from "../../http/router.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { respondJson } from "../../http/respond.js";
import { RequestBodyError } from "../../http/body.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { SkillRegistryError } from "../errors.js";
import { SkillContractError } from "../../../shared/skills/errors.js";

export function skillManagementProtection(owner: (context: RouteContext) => string) {
  return (handler: (context: RouteContext, actor: string) => Promise<void> | void): Route["handler"] =>
    async (context) => {
      try {
        if (
          context.req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: context.req.headers.host,
            origin: context.req.headers.origin,
            fetchSite: context.req.headers["sec-fetch-site"],
          })
        )
          return respondJson(context.res, 403, errorPayload("skills.identityRequired"));
        let actor: string;
        try {
          actor = owner(context);
        } catch {
          return respondJson(context.res, 403, errorPayload("skills.identityRequired"));
        }
        await handler(context, actor);
      } catch (error) {
        if (error instanceof SkillContractError)
          return respondJson(context.res, error.code === "packageTooLarge" ? 413 : 400, {
            ...errorPayload("skills.invalidInput"),
            code: error.code,
          });
        if (error instanceof SkillRegistryError) {
          const status =
            error.code === "unavailable" || error.code === "unsupportedSchema"
              ? 503
              : error.code === "approvalRequired"
                ? 403
                : error.code === "notInstalled" || error.code === "notFound"
                  ? 404
                  : error.code === "invalidInput"
                    ? 400
                    : 409;
          return respondJson(context.res, status, { ...errorPayload(`skills.${error.code}`), code: error.code });
        }
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("skills.invalidInput"));
        reportDiagnostic("skill-management", error);
        respondJson(context.res, 503, errorPayload("skills.unavailable"));
      }
    };
}
