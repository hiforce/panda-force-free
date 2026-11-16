import type { SQL } from "bun";
import type { AsyncEditorialSources } from "../async-ports.js";
import type { EditorialModel } from "../model/contracts.js";
import { MySQLEditorialSession } from "../mysql-session.js";
import { MySQLEditorialRepository } from "../mysql-repository.js";
import { MySQLEditorialService } from "../mysql-service.js";
import { MySQLEditorialJobRepository } from "../jobs/mysql-repository.js";
import { MySQLEditorialJobs } from "../jobs/mysql-service.js";
import { MySQLEditorialWorker } from "../jobs/mysql-worker.js";
import { richSpacingProcessor } from "../adapters/spacing.js";
import { editorialRunner } from "../jobs/runner.js";
import { editorialRoutes } from "./routes.js";
import { editorialJobRoutes } from "./job-routes.js";
/** Async sources retain their native file/Git write boundary and durable receipt recovery. The caller owns the pool. */
export function createMySQLEditorialFeature(
  sql: SQL,
  sources: AsyncEditorialSources | ((session: MySQLEditorialSession) => AsyncEditorialSources),
  options: { models?: ReadonlyMap<string, EditorialModel>; configurationInvalid?: boolean } = {},
) {
  const models = options.models ?? new Map<string, EditorialModel>(),
    session = new MySQLEditorialSession(sql),
    repository = new MySQLEditorialRepository(session),
    sourcePort = typeof sources === "function" ? sources(session) : sources,
    service = new MySQLEditorialService(repository, sourcePort, new Map([["spacing", richSpacingProcessor]])),
    jobRepository = new MySQLEditorialJobRepository(session),
    jobs = new MySQLEditorialJobs(jobRepository, sourcePort, models),
    runner = editorialRunner(new MySQLEditorialWorker(jobRepository, service, sourcePort, models));
  return {
    session,
    repository,
    jobRepository,
    service,
    jobs,
    start: runner.start,
    stop: runner.stop,
    routes: [
      ...editorialRoutes(service),
      ...editorialJobRoutes(jobs, models, runner.wake, !!options.configurationInvalid),
    ],
  };
}
