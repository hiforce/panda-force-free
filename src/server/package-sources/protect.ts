import type { Route, RouteContext } from "../http/router.js";
import { matchesRequestOrigin } from "../auth/origin.js";
import { respondJson } from "../http/respond.js";
import { RequestBodyError } from "../http/body.js";
import { errorPayload } from "../i18n/error-payload.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { SourceError } from "../../shared/packages/sources/contracts.js";
import { SourceStageError } from "../../shared/packages/stages/contracts.js";
import type { ServerResponse } from "node:http";

function status(error: SourceStageError | SourceError): number {
  switch (error.code) {
    case "stageNotFound":
      return 404;
    case "stageConflict":
    case "stageBusy":
    case "sourceChanged":
      return 409;
    case "stageCapacity":
    case "sourceRateLimited":
      return 429;
    case "sourceTooLarge":
      return 413;
    case "sourceAccessDenied":
      return 403;
    case "stageUnavailable":
    case "sourceUnavailable":
    case "sourceTimedOut":
      return 503;
    default:
      return 400;
  }
}

export function respondSourceError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof SourceStageError || error instanceof SourceError)) return false;
  respondJson(res, status(error), { ...errorPayload(`sources.${error.code}`), code: error.code });
  return true;
}

/** The application principal and origin are established before any source body or provider is consumed. */
export function sourceRouteProtection(owner: (context: RouteContext) => string) {
  return (run: (context: RouteContext, actor: string) => void | Promise<void>): Route["handler"] =>
    async (context) => {
      if (
        context.req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: context.req.headers.host,
          origin: context.req.headers.origin,
          fetchSite: context.req.headers["sec-fetch-site"],
        })
      )
        return respondJson(context.res, 403, errorPayload("sources.identityRequired"));
      let actor: string;
      try {
        actor = owner(context);
      } catch {
        return respondJson(context.res, 403, errorPayload("sources.identityRequired"));
      }
      try {
        await run(context, actor);
      } catch (error) {
        if (respondSourceError(context.res, error)) return;
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("sources.stageInvalidInput"));
        reportDiagnostic("package-source-api", error);
        respondJson(context.res, 503, errorPayload("sources.stageUnavailable"));
      }
    };
}
