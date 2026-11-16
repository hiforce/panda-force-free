import { matchesRequestOrigin } from "../../auth/origin.js";
import { RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { Route, RouteContext } from "../../http/router.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { PluginPackageError } from "../../../shared/plugins/contracts.js";
import { PluginRegistryError } from "../errors.js";

import { DocumentError } from "../../documents/errors.js";
import { SiteBuildError } from "../../builds/errors.js";
import { BuildError } from "../../../shared/builds/errors.js";
import { ThemeSelectionError } from "../../../shared/presentation/themes.js";

export function pluginRouteProtection(owner: (context: RouteContext) => string) {
  return (handler: (context: RouteContext, actor: string) => void | Promise<void>): Route["handler"] =>
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
          throw new PluginRegistryError("crossOrigin");
        let actor: string;
        try {
          actor = owner(context);
        } catch {
          throw new PluginRegistryError("identityRequired");
        }
        await handler(context, actor);
      } catch (error) {
        if (error instanceof PluginPackageError || error instanceof PluginRegistryError) {
          const status =
            error instanceof PluginPackageError
              ? error.code === "packageTooLarge"
                ? 413
                : 400
              : error.code === "sampleBusy"
                ? 429
                : error.code === "invalidLibraryDraft"
                  ? 400
                  : error.code === "libraryStorageFull"
                    ? 507
                    : ["approvalRequired", "identityRequired", "crossOrigin"].includes(error.code)
                      ? 403
                      : [
                            "packageNotInstalled",
                            "libraryNotFound",
                            "sampleNotFound",
                            "sampleArtifactUnavailable",
                            "exportUnavailable",
                          ].includes(error.code)
                        ? 404
                        : ["packageUnavailable", "unsupportedSchema"].includes(error.code)
                          ? 503
                          : 409;
          return respondJson(context.res, status, { ...errorPayload(`plugins.${error.code}`), code: error.code });
        }
        if (error instanceof DocumentError)
          return respondJson(context.res, error.status, {
            ...errorPayload(`documents.${error.code}`),
            code: error.code,
          });
        if (error instanceof SiteBuildError)
          return respondJson(context.res, error.status, { ...errorPayload(`builds.${error.code}`), code: error.code });
        if (error instanceof BuildError)
          return respondJson(context.res, error.status, { ...errorPayload("builds.invalidInput"), code: error.code });
        if (error instanceof ThemeSelectionError)
          return respondJson(context.res, 404, { ...errorPayload("plugins.sampleNotFound"), code: "sampleNotFound" });
        if (error instanceof RequestBodyError)
          return respondJson(
            context.res,
            error.status,
            errorPayload(error.status === 413 ? "plugins.packageTooLarge" : "plugins.invalidPackage"),
          );
        reportDiagnostic("plugins-api", error);
        respondJson(context.res, 503, errorPayload("plugins.packageUnavailable"));
      }
    };
}
