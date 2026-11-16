import type { Translate } from "../../shared/i18n/messages.js";
import { siteBuildApi, SiteBuildApiError } from "./api.js";
import { createStaticSitePreview } from "../static-site-preview.js";

export function createSitePreview(t: Translate) {
  return createStaticSitePreview(t, {
    ...siteBuildApi,
    errorPayload: (error) => (error instanceof SiteBuildApiError ? error.payload : null),
  });
}
