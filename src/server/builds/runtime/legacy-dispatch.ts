import type { BuildRunDispatcher, LegacyBuildRunInputsMetadata } from "./ports.js";
import type { SiteExecutor } from "../executor-port.js";
import type { BuildAuthorityPort } from "../authority.js";
import { SiteBuildError } from "../errors.js";
/** Retain the legacy protocol and observe accepted package jobs before requiring a fresh dispatch grant. */
export function legacyBuildRunDispatcher(
  inputs: LegacyBuildRunInputsMetadata,
  executor: SiteExecutor,
  authorize: BuildAuthorityPort,
): BuildRunDispatcher {
  return {
    async start(job, scope) {
      const input = await inputs.input(job.id);
      if (input.theme?.package) {
        try {
          return await executor.status(job.id);
        } catch (error) {
          if (!(error instanceof SiteBuildError && error.code === "executorMissing")) throw error;
        }
      }
      if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
      if ((await scope.current()).phase === "cancelling") return executor.cancel(job.id);
      await authorize(input);
      const latest = await scope.current();
      if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
      if (["cancelling", "cancelled"].includes(latest.phase)) return executor.cancel(job.id);
      if (["completed", "failed"].includes(latest.phase)) throw new SiteBuildError("executorConflict", 409);
      return executor.start(job.id, input);
    },
  };
}
