import type { Translate } from "../../shared/i18n/messages.js";
import type { SiteSampleBuild } from "../../shared/plugins/site-samples.js";
import { siteSampleApi } from "./api.js";
import { createBuildSampleMonitor } from "./monitor.js";

/** Existing publishing-style callers retain their sample source and transport unchanged. */
export function createSiteSampleMonitor(
  t: Translate,
  options: {
    completed?: (job: SiteSampleBuild) => void | Promise<void>;
    illustration?: (target: HTMLElement) => void;
  } = {},
) {
  return createBuildSampleMonitor(t, siteSampleApi, options);
}
