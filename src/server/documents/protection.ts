import { matchesRequestOrigin } from "../auth/origin.js";
import { RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import { errorPayload } from "../i18n/error-payload.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { DocumentError } from "./errors.js";
import { SiteProfileError } from "../../shared/sites/config.js";

export const documentRouteProtection =
  (handler: Route["handler"]): Route["handler"] =>
  async (ctx: RouteContext) => {
    try {
      if (
        ctx.req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: ctx.req.headers.host,
          origin: ctx.req.headers.origin,
          fetchSite: ctx.req.headers["sec-fetch-site"],
        })
      )
        throw new DocumentError("crossOrigin", 403);
      await handler(ctx);
    } catch (error) {
      if (error instanceof SiteProfileError)
        return respondJson(ctx.res, 400, errorPayload("documents.invalidSourceConfiguration"));
      if (error instanceof DocumentError)
        return respondJson(ctx.res, error.status, { ...errorPayload(`documents.${error.code}`), code: error.code });
      if (error instanceof RequestBodyError)
        return respondJson(ctx.res, error.status, errorPayload("documents.invalidInput"));
      reportDiagnostic("documents-api", error);
      respondJson(ctx.res, 503, errorPayload("documents.unavailable"));
    }
  };
