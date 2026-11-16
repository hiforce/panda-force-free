import type { MetadataStore } from "../../shared/async-value.js";
import type { SiteBuildJobs } from "./job-port.js";
import type { SiteBuildArtifacts } from "./artifacts.js";
import type { SiteExecutor } from "./executor-port.js";
import { SiteBuildRetention } from "./retention.js";
import { builtinBuildAuthority, type BuildAuthorityPort } from "./authority.js";
import { BuildRunReconciler } from "./runtime/reconciler.js";
import { legacyBuildRunDispatcher } from "./runtime/legacy-dispatch.js";
import type { BuildRunDispatcher } from "./runtime/ports.js";

/** Document builds provide their existing storage and policy to the shared execution monitor. */
export class SiteBuildReconciler extends BuildRunReconciler {
  constructor(
    jobs: MetadataStore<SiteBuildJobs>,
    artifacts: SiteBuildArtifacts,
    executor: SiteExecutor,
    report: (event: object) => void,
    retention = new SiteBuildRetention(jobs, artifacts),
    authorizeInput: BuildAuthorityPort = builtinBuildAuthority,
    dispatcher?: BuildRunDispatcher,
  ) {
    super(
      jobs,
      artifacts,
      executor,
      report,
      retention,
      dispatcher ?? legacyBuildRunDispatcher(jobs, executor, authorizeInput),
      "site-build",
    );
  }
}
