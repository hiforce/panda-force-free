import type { Database } from "bun:sqlite";
import type { EditorialSources } from "../ports.js";
import { EditorialRepository } from "../repository.js";
import { EditorialService } from "../service.js";
import { richSpacingProcessor } from "../adapters/spacing.js";
import { editorialRoutes } from "./routes.js";
import type { EditorialModel } from "../model/contracts.js";
import { EditorialJobRepository } from "../jobs/repository.js";
import { EditorialJobs } from "../jobs/service.js";
import { EditorialWorker } from "../jobs/worker.js";
import { editorialRunner } from "../jobs/runner.js";
import { editorialJobRoutes } from "./job-routes.js";

/** Composition installs local rules; model-backed modes require their own explicit processor and durable execution. */
export function createEditorialFeature(
  db: Database,
  sources: EditorialSources,
  options: {
    models?: ReadonlyMap<string, EditorialModel>;
    configurationInvalid?: boolean;
    runtimes?: import("../model/runtime.js").EditorialRuntimePort;
  } = {},
) {
  const models = options.models || new Map<string, EditorialModel>();
  const service = new EditorialService(
    new EditorialRepository(db),
    sources,
    new Map([["spacing", richSpacingProcessor]]),
  );
  const repository = new EditorialJobRepository(db),
    jobs = new EditorialJobs(repository, sources, models, Date.now, options.runtimes),
    runner = editorialRunner(
      new EditorialWorker(repository, service, sources, models, Date.now, 120000, options.runtimes),
    );
  return {
    service,
    jobs,
    start: runner.start,
    stop: runner.stop,
    routes: [
      ...editorialRoutes(service),
      ...editorialJobRoutes(jobs, models, runner.wake, !!options.configurationInvalid, !!options.runtimes),
    ],
  };
}
