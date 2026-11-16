import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { OfficePresentationError } from "../../../shared/slides/contracts.js";
import type { MessageId } from "../../../shared/i18n/messages.js";
import type { ServerResponse } from "node:http";
import { respondJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";

/** Format diagnostics use closed localized messages; raw XML and source bytes never enter error responses. */
export function respondNativeSlidesError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof NativeSlidesTemplateError || error instanceof OfficePresentationError)) return false;
  const status =
    error.code === "limitExceeded"
      ? 413
      : error.code === "unavailable"
        ? 503
        : ["notFound", "partNotFound"].includes(error.code)
          ? 404
          : ["disabled", "licenseNotAcknowledged"].includes(error.code)
            ? 403
            : error.code === "storageFull"
              ? 429
              : ["sourceChanged", "conflict", "busy", "immutableVersion", "reviewChanged"].includes(error.code)
                ? 409
                : 400;
  const labels: Partial<Record<typeof error.code, MessageId>> = {
    invalidMapping: "templates.officeInvalidMapping",
    unsupportedShape: "templates.officeInvalidMapping",
    unsupportedPackage: "templates.officeUnsupportedPackage",
    limitExceeded: "templates.officeLimit",
    partNotFound: "templates.officePartUnavailable",
    notFound: "plugins.packageUnavailable",
    unavailable: "plugins.packageUnavailable",
    conflict: "plugins.registryConflict",
    busy: "sources.stageBusy",
    storageFull: "templates.nativeStorageFull",
    immutableVersion: "plugins.immutableVersion",
    reviewChanged: "plugins.reviewChanged",
    sourceChanged: "plugins.reviewChanged",
    disabled: "plugins.packageDisabled",
    licenseNotAcknowledged: "templates.officeLicenseRequired",
  };
  respondJson(res, status, {
    ...errorPayload(labels[error.code] || "templates.officeInvalidPackage"),
    code: error.code,
  });
  return true;
}
