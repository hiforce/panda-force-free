import type { SiteExecutor } from "../executor-port.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { SiteBuildJobs, BuildMutation } from "../job-port.js";
import type { NativeProjectJobs } from "../native/project-ports.js";
import type { NativeBuildThemeMetadata } from "../native/ports.js";
import type { BuildAuthorityPort } from "../authority.js";
import type { NativeBuildThemeRef } from "../../../shared/builds/native-reference.js";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { BuildSources } from "../source-port.js";
import { SiteBuildRepository } from "../repository.js";
import { SiteBuildArtifacts } from "../artifacts.js";
import { SiteBuildReconciler } from "../reconciler.js";
import { SiteBuildService } from "../service.js";
import { SiteBuildPreview } from "../preview.js";
import { HttpSiteExecutor } from "../adapters/http-executor.js";
import { siteBuildRoutes } from "./routes.js";
import { SiteBuildRetention } from "../retention.js";
import type { BuildInputBudget } from "../resource-input-port.js";
import { FileResourceBuildInputs } from "../resource-inputs.js";
import { NativeProjectBuildService } from "../native/project-service.js";
import { resourceBuildDispatcher } from "../resource-dispatch.js";
import { legacyBuildRunDispatcher } from "../runtime/legacy-dispatch.js";
import { builtinBuildAuthority } from "../authority.js";
import { SiteBuildError } from "../errors.js";
import type { RouteContext } from "../../http/router.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { DocumentError } from "../../documents/errors.js";

export function createSiteBuildFeature(options: {
  db?: Database | null;
  transaction?: BuildMutation;
  jobs?: MetadataStore<SiteBuildJobs> & {
    resources: MetadataStore<NativeProjectJobs> & {
      identity(
        id: string,
      ): { actor: string; theme: NativeBuildThemeRef } | Promise<{ actor: string; theme: NativeBuildThemeRef }>;
    };
  };
  sources: BuildSources;
  stateRoot: string;
  executor?: SiteExecutor | null;
  executorUrl?: string;
  tokenFile?: string;
  authorizeInput?: BuildAuthorityPort;
  nativeThemes?: NativeBuildThemeMetadata;
  inputBudget?: BuildInputBudget;
  owner?: (context: RouteContext) => string;
}) {
  if (!options.jobs && !options.db) throw new Error("siteBuildStorageRequired");
  const jobs = options.jobs ?? new SiteBuildRepository(options.db!),
    artifacts = new SiteBuildArtifacts(join(options.stateRoot, "data", "site-builds"));
  const retention = new SiteBuildRetention(jobs, artifacts);
  const executor =
    options.executor !== undefined
      ? options.executor
      : options.executorUrl && options.tokenFile
        ? new HttpSiteExecutor(options.executorUrl, options.tokenFile)
        : null;
  const files =
      options.nativeThemes && options.inputBudget
        ? new FileResourceBuildInputs(join(options.stateRoot, "data", "site-build-inputs"), options.inputBudget)
        : null,
    nativeDispatch =
      files && options.nativeThemes && executor
        ? resourceBuildDispatcher(
            (id) => jobs.resources.identity(id),
            files,
            options.nativeThemes,
            executor,
            async (id) => {
              const job = await jobs.get(id);
              try {
                await options.sources.authorize(job.spaceId, job.projectId);
              } catch (error) {
                if (
                  (error instanceof DocumentError || error instanceof SiteBuildError) &&
                  [400, 401, 403, 404, 409].includes(error.status)
                )
                  throw new SiteBuildError("snapshotUnavailable", error.status);
                throw error;
              }
            },
          )
        : null,
    legacy = executor
      ? legacyBuildRunDispatcher(jobs, executor, options.authorizeInput ?? builtinBuildAuthority)
      : null;
  const reconciler = executor
    ? new SiteBuildReconciler(
        jobs,
        artifacts,
        executor,
        (event) => console.info("[site-build]", JSON.stringify(event)),
        retention,
        options.authorizeInput,
        {
          async start(job, scope) {
            if ((await jobs.get(job.id)).inputProtocol === 2) {
              if (!nativeDispatch) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
              return nativeDispatch.start(job, scope);
            }
            return legacy!.start(job, scope);
          },
        },
      )
    : null;
  const native =
    files && options.nativeThemes
      ? new NativeProjectBuildService(
          jobs.resources,
          files,
          options.nativeThemes,
          () => reconciler?.wake(),
          Date.now,
          options.transaction,
        )
      : undefined;
  const service = new SiteBuildService(
    options.sources,
    jobs,
    artifacts,
    executor,
    reconciler,
    options.authorizeInput,
    native,
    options.transaction,
  );
  let maintenance: Promise<void> | undefined,
    closing: Promise<void> | undefined,
    nextPrune = 0,
    stopped = false;
  const maintain = () => {
    if (stopped || maintenance) return;
    maintenance = service
      .recover()
      .then(async () => {
        if (Date.now() >= nextPrune) {
          await retention.prune();
          nextPrune = Date.now() + 3600000;
        }
      })
      .catch((error) => reportDiagnostic("site-build-maintenance", error))
      .finally(() => {
        maintenance = undefined;
      });
  };
  maintain();
  const timer = setInterval(maintain, 10000);
  timer.unref();
  reconciler?.wake();
  return {
    service,
    routes: siteBuildRoutes(
      service,
      (actor) =>
        new SiteBuildPreview({ requireArtifact: (id) => service.requireArtifact(id, actor) }, artifacts, {
          cacheDurationMs: 0,
        }),
      options.owner,
    ),
    stop: () => {
      clearInterval(timer);
      stopped = true;
      retention.stop();
      reconciler?.stop();
    },
    close() {
      return (closing ??= (async () => {
        clearInterval(timer);
        stopped = true;
        retention.stop();
        reconciler?.stop();
        await service.close();
        await reconciler?.drain();
        await maintenance;
        await retention.drain();
      })());
    },
  };
}
