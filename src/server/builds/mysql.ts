import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore, type MySQLLedgerTransaction } from "../packages/mysql-ledger.js";
import { createHash } from "node:crypto";
import type { BuildInput } from "../../shared/builds/contracts.js";
import type { SiteBuild, SiteBuildRequest, BuildSourceRevision } from "../../shared/builds/jobs.js";
import { SiteBuildError } from "./errors.js";
import { utf8Prefix } from "../../shared/utf8.js";
import { buildThemeMetadata } from "../../shared/builds/theme.js";
import { buildProjectMetadata } from "../../shared/builds/project.js";
import { terminalBuildRun } from "../../shared/builds/run.js";
import type { ResourceBuildRequest } from "../../shared/builds/resources.js";
import type { BuildRunChanges } from "../../shared/builds/run.js";
import { MySQLProjectResourceRepository } from "./mysql-project-resource-repository.js";
import type { SiteBuildJobs } from "./job-port.js";
export const terminalBuild = terminalBuildRun;
export const hashBuildInput = (input: BuildInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
/** MySQL owns application intent and recovery; the executor owns container execution. */
export class MySQLSiteBuildRepository extends MySQLLedger implements AsyncStore<SiteBuildJobs> {
  public override transaction<T>(work: () => Promise<T>): Promise<T> {
    return super.transaction(work);
  }
  readonly resources: MySQLProjectResourceRepository;
  constructor(pool: SQL, documentTransaction?: MySQLLedgerTransaction) {
    super(
      pool,
      "panda_force_site_builds_guard",
      ["terminal", "removed", "createdAt", "total", "visible", "active"],
      documentTransaction,
    );
    this.resources = new MySQLProjectResourceRepository(
      pool,
      {
        existing: (request, actor) => this.existing(request, actor),
        stored: (id) => this.stored(id),
        update: (id, changes) => this.update(id, changes),
        insert: (request, resource, sources, snapshot) =>
          this.insert(request, resource.descriptor.input, sources, snapshot, resource),
      },
      documentTransaction,
    );
  }
  async existing(request: SiteBuildRequest, actor?: string): Promise<SiteBuild | null> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          request: string;
          record: string;
        },
        [string]
      >("SELECT request,record FROM panda_force_site_builds WHERE id=?").get(request.id);
      if (!row) return null;
      const job = JSON.parse(row.record) as SiteBuild;
      if (job.inputProtocol === 2) await this.resources.authorize(actor, job.id);
      if (row.request !== JSON.stringify(request)) throw new SiteBuildError("idempotencyConflict", 409);
      return job;
    });
  }
  async create(
    request: SiteBuildRequest,
    input: BuildInput,
    sources: BuildSourceRevision[],
    sourceSnapshot?: SiteBuild["sourceSnapshot"],
  ) {
    return this.transaction(async () => {
      if (request.nativeTheme) throw new SiteBuildError("invalidInput");
      const existing = await this.existing(request);
      if (existing) return existing;
      return await this.insert(request, input, sources, sourceSnapshot);
    });
  }
  private async insert(
    request: SiteBuildRequest,
    input: BuildInput,
    sources: BuildSourceRevision[],
    sourceSnapshot?: SiteBuild["sourceSnapshot"],
    resource?: ResourceBuildRequest,
  ) {
    const count = (await this.query<
      {
        total: number;
        visible: number;
        active: number;
      },
      []
    >(
      "SELECT count(*) AS total,COALESCE(sum(removed=0),0) AS visible,COALESCE(sum(terminal=0),0) AS active FROM panda_force_site_builds",
    ).get())!;
    if (count.active >= 4) throw new SiteBuildError("busy", 429);
    if (count.visible >= 1000 || count.total >= 10000) throw new SiteBuildError("historyFull", 507);
    const job: SiteBuild = {
      id: request.id,
      spaceId: request.spaceId,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      ...(sourceSnapshot ? { sourceSnapshot } : {}),
      engine: input.engine,
      preset: input.preset,
      ...(input.theme ? { theme: buildThemeMetadata(input.theme) } : {}),
      ...(input.project ? { project: buildProjectMetadata(input.project) } : {}),
      ...(resource
        ? {
            inputProtocol: 2 as const,
            nativeTheme: {
              ...request.nativeTheme!,
              source: resource.descriptor.theme.source,
              engineVersion: resource.descriptor.theme.engineVersion,
            },
          }
        : {}),
      site: input.site,
      sources,
      inputHash: resource?.digest ?? hashBuildInput(input),
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      connection: "ready",
      outputBytes: 0,
      fileCount: 0,
      artifactAvailable: false,
      image: null,
    };
    await this.query(
      "INSERT INTO panda_force_site_builds(id,spaceId,request,record,input,createdAt,projectId,logs) VALUES(?,?,?,?,?,?,?,'')",
    ).run(
      job.id,
      job.spaceId,
      JSON.stringify(request),
      JSON.stringify(job),
      resource ? null : JSON.stringify(input),
      job.createdAt,
      request.projectId ?? null,
    );
    return job;
  }
  private async stored(id: string): Promise<SiteBuild> {
    const row = await this.query<
      {
        record: string;
      },
      [string]
    >("SELECT record FROM panda_force_site_builds WHERE id=?").get(id);
    if (!row) throw new SiteBuildError("notFound", 404);
    return JSON.parse(row.record);
  }
  async get(id: string): Promise<SiteBuild> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          removed: number;
        },
        [string]
      >("SELECT removed FROM panda_force_site_builds WHERE id=?").get(id);
      if (!row || row.removed) throw new SiteBuildError("notFound", 404);
      return await this.stored(id);
    });
  }
  async input(id: string): Promise<BuildInput> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          input: string | null;
        },
        [string]
      >("SELECT input FROM panda_force_site_builds WHERE id=?").get(id);
      if (!row?.input) throw new SiteBuildError("snapshotUnavailable", 503);
      const input: BuildInput = JSON.parse(row.input);
      if (hashBuildInput(input) !== (await this.get(id)).inputHash)
        throw new SiteBuildError("snapshotUnavailable", 503);
      return input;
    });
  }
  async update(id: string, changes: BuildRunChanges) {
    return this.transaction(async () => {
      const current = await this.stored(id),
        safe = Object.fromEntries(
          Object.entries(changes).filter(([key]) =>
            ["phase", "connection", "error", "image", "outputBytes", "fileCount", "artifactAvailable"].includes(key),
          ),
        );
      if (terminalBuild(current) && changes.phase && changes.phase !== current.phase)
        throw new SiteBuildError("executorConflict", 409);
      const job = { ...current, ...safe, updatedAt: Date.now() } as SiteBuild;
      await this.query(
        "UPDATE panda_force_site_builds SET record=?,terminal=?,input=CASE WHEN ?=1 THEN NULL ELSE input END WHERE id=?",
      ).run(JSON.stringify(job), Number(terminalBuild(job)), Number(terminalBuild(job)), id);
      return job;
    });
  }
  async list(spaceId: string, before = Number.MAX_SAFE_INTEGER, projectId?: string) {
    return this.readSnapshot(async () => {
      return (
        await this.query<
          {
            record: string;
          },
          [string, number, string | null]
        >(
          "SELECT record FROM panda_force_site_builds WHERE spaceId=? AND sequence<? AND projectId <=> ? AND removed=0 ORDER BY sequence DESC LIMIT 100",
        ).all(spaceId, before, projectId ?? null)
      ).map((row) => JSON.parse(row.record) as SiteBuild);
    });
  }
  async active(): Promise<SiteBuild[]> {
    return this.readSnapshot(async () => {
      return (
        await this.query<
          {
            record: string;
          },
          []
        >(
          "SELECT b.record FROM panda_force_site_builds b LEFT JOIN panda_force_site_build_resource_inputs r ON r.id=b.id WHERE b.terminal=0 AND b.removed=0 AND (r.id IS NULL OR r.ready=1) ORDER BY b.sequence",
        ).all()
      ).map((row) => JSON.parse(row.record));
    });
  }
  async artifacts(): Promise<SiteBuild[]> {
    return this.readSnapshot(async () => {
      return (
        await this.query<
          {
            record: string;
          },
          []
        >("SELECT record FROM panda_force_site_builds WHERE terminal=1 AND removed=0 ORDER BY sequence DESC").all()
      )
        .map((row) => JSON.parse(row.record) as SiteBuild)
        .filter((job) => job.artifactAvailable);
    });
  }
  async logs(id: string) {
    return this.readSnapshot(async () => {
      await this.get(id);
      return (await this.query<
        {
          logs: string;
        },
        [string]
      >("SELECT logs FROM panda_force_site_builds WHERE id=?").get(id))!.logs;
    });
  }
  async saveLogs(id: string, value: string) {
    return this.transaction(async () => {
      await this.query("UPDATE panda_force_site_builds SET logs=? WHERE id=?").run(utf8Prefix(value, 128 * 1024), id);
    });
  }
  async remove(id: string) {
    return this.transaction(async () => {
      const job = await this.get(id);
      if (!terminalBuild(job)) throw new SiteBuildError("buildActive", 409);
      if (job.inputProtocol === 2) {
        await this.update(id, { artifactAvailable: false });
        await this.query("UPDATE panda_force_site_builds SET removed=1 WHERE id=?").run(id);
      } else await this.query("DELETE FROM panda_force_site_builds WHERE id=?").run(id);
    });
  }
}
