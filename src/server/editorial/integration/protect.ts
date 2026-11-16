import type { Route, RouteContext } from "../../http/router.js";
import { auditPrincipal } from "../../auth/audit-principal.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { EditorialError } from "../errors.js";

export function editorialField(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new EditorialError("invalidInput");
  return value.trim();
}
export function editorialOwner(context: RouteContext) {
  try {
    return auditPrincipal(context.idaasSession?.identity);
  } catch {
    throw new EditorialError("unavailable", 503);
  }
}
export const protectEditorial =
  (handler: Route["handler"]): Route["handler"] =>
  async (context) => {
    try {
      const { req } = context;
      if (
        req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: req.headers.host,
          origin: req.headers.origin,
          fetchSite: req.headers["sec-fetch-site"],
        })
      )
        throw new EditorialError("crossOrigin", 403);
      await handler(context);
    } catch (error) {
      if (error instanceof EditorialError)
        return respondJson(context.res, error.status, { ...errorPayload(`editorial.${error.code}`), code: error.code });
      if (error instanceof RequestBodyError)
        return respondJson(context.res, error.status, errorPayload("editorial.invalidInput"));
      reportDiagnostic("editorial-api", error);
      respondJson(context.res, 503, errorPayload("editorial.unavailable"));
    }
  };
