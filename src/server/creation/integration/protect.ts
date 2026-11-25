import type { Route, RouteContext } from "../../http/router.js";
import { RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { CreationError } from "../contracts.js";
import { DocumentError } from "../../documents/errors.js";
import { SkillRegistryError } from "../../skills/errors.js";
import { SkillContractError } from "../../../shared/skills/errors.js";

export function creationProtection(owner: (context: RouteContext) => string) {
  return (run: (context: RouteContext, owner: string) => Promise<void>): Route["handler"] =>
    async (context) => {
      if (
        context.req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: context.req.headers.host,
          origin: context.req.headers.origin,
          fetchSite: context.req.headers["sec-fetch-site"],
        })
      )
        return respondJson(context.res, 403, errorPayload("creation.identityRequired"));
      let actor: string;
      try {
        actor = owner(context);
      } catch {
        return respondJson(context.res, 403, errorPayload("creation.identityRequired"));
      }
      try {
        await run(context, actor);
      } catch (error) {
        if (error instanceof CreationError) {
          if (error.code === "runtimeSelectionUnavailable")
            return respondJson(context.res, 409, { ...errorPayload("harness.selectionError"), code: error.code });
          const status =
            error.code === "notFound"
              ? 404
              : error.code === "unavailable"
                ? 503
                : ["conflict", "leaseLost", "updateClosed"].includes(error.code)
                  ? 409
                  : 400;
          return respondJson(context.res, status, { ...errorPayload(`creation.${error.code}`), code: error.code });
        }
        if (error instanceof SkillContractError)
          return respondJson(context.res, 400, { ...errorPayload("creation.unsupportedSkill"), code: error.code });
        if (error instanceof SkillRegistryError)
          return respondJson(context.res, error.code === "unavailable" ? 503 : 409, {
            ...errorPayload("creation.unsupportedSkill"),
            code: error.code,
          });
        if (error instanceof DocumentError)
          return respondJson(
            context.res,
            error.status,
            errorPayload(error.status === 404 ? "creation.notFound" : "creation.conflict"),
          );
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("creation.invalidInput"));
        reportDiagnostic("creation-request", error);
        respondJson(context.res, 503, errorPayload("creation.unavailable"));
      }
    };
}
