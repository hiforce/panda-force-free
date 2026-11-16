import type { Database } from "bun:sqlite";
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
import { ProjectResourceRepository, installProjectResourceSchema } from "./project-resource-repository.js";
import type { SiteBuildJobs } from "./job-port.js";

export const terminalBuild = terminalBuildRun;
export const hashBuildInput = (input: BuildInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** SQLite owns application intent and recovery; the executor owns container execution. */
export class SiteBuildRepository implements SiteBuildJobs {
  readonly resources: ProjectResourceRepository;
  constructor(private db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS site_build_schema(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
    );
    db.transaction(() => {
      const version =
        db.query<{ version: number }, []>("SELECT version FROM site_build_schema WHERE id=1").get()?.version || 0;
      if (version > 3) throw new SiteBuildError("unavailable", 503);
      if (!version)
        db.exec(`CREATE TABLE site_builds (
        id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL,
        input TEXT, logs TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, terminal INTEGER NOT NULL DEFAULT 0
      ); CREATE INDEX site_builds_by_space ON site_builds(spaceId,createdAt DESC);
      INSERT INTO site_build_schema(id,version) VALUES(1,1);`);
      if (version < 2)
        db.exec(`ALTER TABLE site_builds ADD COLUMN projectId TEXT;
        CREATE INDEX site_builds_by_project_space ON site_builds(projectId,spaceId,createdAt DESC);
        UPDATE site_build_schema SET version=2 WHERE id=1;`);
      if (version < 3) installProjectResourceSchema(db);
    }).immediate();
    this.resources = new ProjectResourceRepository(db, {
      existing: (request, actor) => this.existing(request, actor),
      stored: (id) => this.stored(id),
      update: (id, changes) => this.update(id, changes),
      insert: (request, resource, sources, snapshot) =>
        this.insert(request, resource.descriptor.input, sources, snapshot, resource),
    });
  }
  existing(request: SiteBuildRequest, actor?: string): SiteBuild | null {
    const row = this.db
      .query<{ request: string; record: string }, [string]>("SELECT request,record FROM site_builds WHERE id=?")
      .get(request.id);
    if (!row) return null;
    const job = JSON.parse(row.record) as SiteBuild;
    if (job.inputProtocol === 2) this.resources.authorize(actor, job.id);
    if (row.request !== JSON.stringify(request)) throw new SiteBuildError("idempotencyConflict", 409);
    return job;
  }
  create(
    request: SiteBuildRequest,
    input: BuildInput,
    sources: BuildSourceRevision[],
    sourceSnapshot?: SiteBuild["sourceSnapshot"],
  ) {
    if (request.nativeTheme) throw new SiteBuildError("invalidInput");
    return this.db
      .transaction(() => {
        const existing = this.existing(request);
        if (existing) return existing;
        return this.insert(request, input, sources, sourceSnapshot);
      })
      .immediate();
  }
  private insert(
    request: SiteBuildRequest,
    input: BuildInput,
    sources: BuildSourceRevision[],
    sourceSnapshot?: SiteBuild["sourceSnapshot"],
    resource?: ResourceBuildRequest,
  ) {
    const count = this.db
      .query<{ total: number; visible: number; active: number }, []>(
        "SELECT count(*) AS total,COALESCE(sum(removed=0),0) AS visible,COALESCE(sum(terminal=0),0) AS active FROM site_builds",
      )
      .get()!;
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
    this.db
      .query("INSERT INTO site_builds(id,spaceId,request,record,input,createdAt,projectId) VALUES(?,?,?,?,?,?,?)")
      .run(
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
  private stored(id: string): SiteBuild {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM site_builds WHERE id=?").get(id);
    if (!row) throw new SiteBuildError("notFound", 404);
    return JSON.parse(row.record);
  }
  get(id: string): SiteBuild {
    const row = this.db.query<{ removed: number }, [string]>("SELECT removed FROM site_builds WHERE id=?").get(id);
    if (!row || row.removed) throw new SiteBuildError("notFound", 404);
    return this.stored(id);
  }
  input(id: string): BuildInput {
    const row = this.db.query<{ input: string | null }, [string]>("SELECT input FROM site_builds WHERE id=?").get(id);
    if (!row?.input) throw new SiteBuildError("snapshotUnavailable", 503);
    const input: BuildInput = JSON.parse(row.input);
    if (hashBuildInput(input) !== this.get(id).inputHash) throw new SiteBuildError("snapshotUnavailable", 503);
    return input;
  }
  update(id: string, changes: BuildRunChanges) {
    return this.db
      .transaction(() => {
        const current = this.stored(id),
          safe = Object.fromEntries(
            Object.entries(changes).filter(([key]) =>
              ["phase", "connection", "error", "image", "outputBytes", "fileCount", "artifactAvailable"].includes(key),
            ),
          );
        if (terminalBuild(current) && changes.phase && changes.phase !== current.phase)
          throw new SiteBuildError("executorConflict", 409);
        const job = { ...current, ...safe, updatedAt: Date.now() } as SiteBuild;
        this.db
          .query("UPDATE site_builds SET record=?,terminal=?,input=CASE WHEN ?=1 THEN NULL ELSE input END WHERE id=?")
          .run(JSON.stringify(job), Number(terminalBuild(job)), Number(terminalBuild(job)), id);
        return job;
      })
      .immediate();
  }
  list(spaceId: string, before = Number.MAX_SAFE_INTEGER, projectId?: string) {
    return this.db
      .query<{ record: string }, [string, number, string | null]>(
        "SELECT record FROM site_builds WHERE spaceId=? AND rowid<? AND projectId IS ? AND removed=0 ORDER BY rowid DESC LIMIT 100",
      )
      .all(spaceId, before, projectId ?? null)
      .map((row) => JSON.parse(row.record) as SiteBuild);
  }
  active(): SiteBuild[] {
    return this.db
      .query<{ record: string }, []>(
        "SELECT b.record FROM site_builds b LEFT JOIN site_build_resource_inputs r ON r.id=b.id WHERE b.terminal=0 AND b.removed=0 AND (r.id IS NULL OR r.ready=1) ORDER BY b.rowid",
      )
      .all()
      .map((row) => JSON.parse(row.record));
  }
  artifacts(): SiteBuild[] {
    return this.db
      .query<{ record: string }, []>(
        "SELECT record FROM site_builds WHERE terminal=1 AND removed=0 ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(row.record) as SiteBuild)
      .filter((job) => job.artifactAvailable);
  }
  logs(id: string) {
    this.get(id);
    return this.db.query<{ logs: string }, [string]>("SELECT logs FROM site_builds WHERE id=?").get(id)!.logs;
  }
  saveLogs(id: string, value: string) {
    this.db.query("UPDATE site_builds SET logs=? WHERE id=?").run(utf8Prefix(value, 128 * 1024), id);
  }
  remove(id: string) {
    const job = this.get(id);
    if (!terminalBuild(job)) throw new SiteBuildError("buildActive", 409);
    if (job.inputProtocol === 2) {
      this.update(id, { artifactAvailable: false });
      this.db.query("UPDATE site_builds SET removed=1 WHERE id=?").run(id);
    } else this.db.query("DELETE FROM site_builds WHERE id=?").run(id);
  }
}
