import type { Route, RouteContext } from "../../http/router.js";
import type { MessageId } from "../../../shared/i18n/messages.js";
import { RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { PortableTemplateError } from "../../../shared/templates/portable/errors.js";
import { PortableRegistryError } from "../portable/errors.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { respondSourceError } from "../../package-sources/protect.js";
import { DocumentError } from "../../documents/errors.js";
import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { SiteBuildError } from "../../builds/errors.js";
import { respondNativeSlidesError } from "./native-slides-errors.js";

/** All template mutations share origin checks, principal establishment and closed error responses. */
export function templateManagementProtection(owner: (context: RouteContext) => string) {
  return (run: (context: RouteContext, actor: string) => Promise<void> | void): Route["handler"] =>
    async (context) => {
      if (
        context.req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: context.req.headers.host,
          origin: context.req.headers.origin,
          fetchSite: context.req.headers["sec-fetch-site"],
        })
      )
        return respondJson(context.res, 403, errorPayload("plugins.identityRequired"));
      let actor: string;
      try {
        actor = owner(context);
      } catch {
        return respondJson(context.res, 403, errorPayload("plugins.identityRequired"));
      }
      try {
        await run(context, actor);
      } catch (error) {
        if (respondNativeSlidesError(context.res, error)) return;
        if (error instanceof SiteBuildError)
          return respondJson(context.res, error.status, { ...errorPayload("builds." + error.code), code: error.code });
        if (error instanceof NativeThemeError) {
          const labels: Record<NativeThemeError["code"], MessageId> = {
            invalidInput: "plugins.invalidPackage",
            notFound: "plugins.packageUnavailable",
            busy: "sources.stageBusy",
            unavailable: "plugins.packageUnavailable",
            conflict: "plugins.registryConflict",
            immutableVersion: "plugins.immutableVersion",
            reviewChanged: "plugins.reviewChanged",
            executionNotApproved: "templates.nativeApprovalRequired",
            disabled: "plugins.packageDisabled",
            storageFull: "templates.nativeStorageFull",
            incompleteSource: "templates.nativeSourceIncomplete",
            exportTooLarge: "templates.nativeExportTooLarge",
          };
          const status =
            error.code === "notFound"
              ? 404
              : error.code === "exportTooLarge"
                ? 413
                : error.code === "unavailable"
                  ? 503
                  : ["executionNotApproved", "disabled"].includes(error.code)
                    ? 403
                    : error.code === "storageFull"
                      ? 429
                      : ["invalidInput", "incompleteSource"].includes(error.code)
                        ? 400
                        : 409;
          return respondJson(context.res, status, { ...errorPayload(labels[error.code]), code: error.code });
        }
        if (error instanceof DocumentError)
          return respondJson(context.res, error.status, errorPayload(`documents.${error.code}`));
        if (respondSourceError(context.res, error)) return;
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("plugins.invalidPackage"));
        if (error instanceof PortableTemplateError)
          return respondJson(context.res, error.code === "packageTooLarge" ? 413 : 400, {
            ...errorPayload(
              error.code === "unknownPlaceholder"
                ? "templates.unknownPlaceholder"
                : error.code === "invalidParameters"
                  ? "templates.invalidApplicationValues"
                  : "plugins.invalidPackage",
            ),
            code: error.code,
          });
        if (error instanceof PortableRegistryError && error.code !== "unavailable") {
          const status = ["invalidInput", "unsupportedAuthoring"].includes(error.code)
            ? 400
            : ["notInstalled", "draftNotFound"].includes(error.code)
              ? 404
              : error.code === "templateDisabled"
                ? 403
                : 409;
          const labels: Partial<Record<PortableRegistryError["code"], MessageId>> = {
            immutableVersion: "plugins.immutableVersion",
            reviewChanged: "plugins.reviewChanged",
            templateDisabled: "plugins.packageDisabled",
            draftConflict: "templates.draftConflict",
            draftNotFound: "templates.draftNotFound",
            unsupportedAuthoring: "templates.unsupportedAuthoring",
          };
          return respondJson(context.res, status, {
            ...errorPayload(
              labels[error.code] || (status === 400 ? "plugins.invalidPackage" : "plugins.registryConflict"),
            ),
            code: error.code,
          });
        }
        reportDiagnostic("template-management-api", error);
        respondJson(context.res, 503, errorPayload("plugins.packageUnavailable"));
      }
    };
}
