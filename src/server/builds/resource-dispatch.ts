import type { NativeBuildThemeRef } from "../../shared/builds/native-reference.js";
import type { BuildRunDispatcher } from "./runtime/ports.js";
import type { NativeBuildThemeMetadata } from "./native/ports.js";
import type { ResourceBuildInputs } from "./resource-input-port.js";
import type { SiteExecutor } from "./executor-port.js";
import { SiteBuildError } from "./errors.js";
/** Existing execution is observed before local input or a new grant, independently of the requesting feature. */
export function resourceBuildDispatcher(
  identity: (id: string) =>
    | {
        actor: string;
        theme: NativeBuildThemeRef;
      }
    | Promise<{
        actor: string;
        theme: NativeBuildThemeRef;
      }>,
  files: ResourceBuildInputs,
  themes: NativeBuildThemeMetadata,
  executor: SiteExecutor,
  authorizeInput?: (id: string) => Promise<void>,
): BuildRunDispatcher {
  return {
    async start(job, scope) {
      try {
        return await executor.status(job.id);
      } catch (error) {
        if (!(error instanceof SiteBuildError && error.code === "executorMissing")) throw error;
      }
      if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
      if ((await scope.current()).phase === "cancelling") return executor.cancel(job.id);
      if (!executor.startResource) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
      return files.with(job.id, job.inputHash, async (input) => {
        const current = await scope.current(),
          owner = await identity(job.id);
        if (
          input.digest !== current.inputHash ||
          input.engine !== current.engine ||
          input.descriptor.theme.id !== owner.theme.id ||
          input.descriptor.theme.version !== owner.theme.version
        )
          throw new SiteBuildError("snapshotUnavailable", 503);
        if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
        if ((await scope.current()).phase === "cancelling") return executor.cancel(job.id);
        await authorizeInput?.(job.id);
        if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
        if ((await scope.current()).phase === "cancelling") return executor.cancel(job.id);
        await themes.authorize(owner.actor, owner.theme);
        const latest = await scope.current();
        if (scope.closed()) throw new SiteBuildError("executorUnavailable", 503);
        if (["cancelling", "cancelled"].includes(latest.phase)) return executor.cancel(job.id);
        if (["completed", "failed"].includes(latest.phase)) throw new SiteBuildError("executorConflict", 409);
        return executor.startResource!(job.id, input);
      });
    },
  };
}
