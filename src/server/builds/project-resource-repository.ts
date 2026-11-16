import type { Database } from "bun:sqlite";
import type { SiteBuild, SiteBuildRequest, BuildSourceRevision } from "../../shared/builds/jobs.js";
import type { BuildRunChanges } from "../../shared/builds/run.js";
import { terminalBuildRun } from "../../shared/builds/run.js";
import type { ResourceBuildRequest } from "../../shared/builds/resources.js";
import { RESOURCE_FRAME_MAX } from "../../shared/builds/resource-frame.js";
import type { ResourceInputLedger, ResourceInputReservation } from "./resource-input-port.js";
import { SiteBuildError } from "./errors.js";

export interface ProjectResourceRecords {
  existing(request: SiteBuildRequest, actor?: string): SiteBuild | null;
  stored(id: string): SiteBuild;
  insert(
    request: SiteBuildRequest,
    input: ResourceBuildRequest,
    sources: BuildSourceRevision[],
    snapshot?: SiteBuild["sourceSnapshot"],
  ): SiteBuild;
  update(id: string, changes: BuildRunChanges): SiteBuild;
}
interface Row {
  id: string;
  owner: string;
  ready: number;
  reservedBytes: number;
}

export function installProjectResourceSchema(db: Database) {
  db.exec(`ALTER TABLE site_builds ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN(0,1));
    CREATE TABLE site_build_resource_inputs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN(0,1)),reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0));
    UPDATE site_build_schema SET version=3 WHERE id=1;`);
}

/** Only resource metadata participates in the document database transaction; immutable bytes remain in owned files. */
export class ProjectResourceRepository implements ResourceInputLedger<SiteBuild> {
  constructor(
    private db: Database,
    private records: ProjectResourceRecords,
  ) {}
  private row(id: string): Row {
    const row = this.db.query<Row, [string]>("SELECT * FROM site_build_resource_inputs WHERE id=?").get(id);
    if (!row) throw new SiteBuildError("notFound", 404);
    return row;
  }
  authorize(actor: string | undefined, id: string) {
    if (!actor || this.row(id).owner !== actor) throw new SiteBuildError("notFound", 404);
  }
  identity(id: string) {
    const job = this.records.stored(id);
    if (!job.nativeTheme) throw new SiteBuildError("snapshotUnavailable", 503);
    const { id: themeId, version, digest } = job.nativeTheme;
    return { actor: this.row(id).owner, theme: { id: themeId, version, digest } };
  }
  reserve(
    actor: string,
    request: SiteBuildRequest,
    input: ResourceBuildRequest,
    sources: BuildSourceRevision[],
    snapshot?: SiteBuild["sourceSnapshot"],
  ) {
    if (
      !request.nativeTheme ||
      input.engine !== request.engine ||
      input.descriptor.theme.id !== request.nativeTheme.id ||
      input.descriptor.theme.version !== request.nativeTheme.version
    )
      throw new SiteBuildError("invalidInput");
    return this.db
      .transaction(() => {
        const previous = this.records.existing(request, actor);
        if (previous) return { value: this.reservation(previous.id), created: false };
        const totals = this.db
          .query<{ used: number; owned: number }, [string]>(
            "SELECT COALESCE(sum(reservedBytes),0) AS used,COALESCE(sum(CASE WHEN owner=? THEN reservedBytes ELSE 0 END),0) AS owned FROM site_build_resource_inputs",
          )
          .get(actor)!;
        if (totals.used + RESOURCE_FRAME_MAX > 2 * 1024 ** 3 || totals.owned + RESOURCE_FRAME_MAX > 512 * 1024 ** 2)
          throw new SiteBuildError("storageFull", 429);
        const job = this.records.insert(request, input, sources, snapshot);
        this.db
          .query("INSERT INTO site_build_resource_inputs(id,owner,reservedBytes) VALUES(?,?,?)")
          .run(job.id, actor, RESOURCE_FRAME_MAX);
        return { value: this.reservation(job.id), created: true };
      })
      .immediate();
  }
  reservation(id: string): ResourceInputReservation<SiteBuild> {
    const row = this.row(id);
    return { job: this.records.stored(id), ready: !!row.ready, reservedBytes: row.reservedBytes };
  }
  get(id: string) {
    return this.records.stored(id);
  }
  update(id: string, changes: BuildRunChanges) {
    return this.records.update(id, changes);
  }
  accept(id: string, inputHash: string, bytes: number) {
    return this.db
      .transaction(() => {
        const job = this.records.stored(id);
        this.row(id);
        if (job.inputHash !== inputHash || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > RESOURCE_FRAME_MAX)
          throw new SiteBuildError("snapshotUnavailable", 503);
        if (terminalBuildRun(job)) return job;
        const next = job.phase === "cancelling" ? this.records.update(id, { phase: "cancelled" }) : job;
        this.db.query("UPDATE site_build_resource_inputs SET ready=1,reservedBytes=? WHERE id=?").run(bytes, id);
        return next;
      })
      .immediate();
  }
  pending() {
    return this.db
      .query<{ record: string; ready: number; reservedBytes: number }, []>(
        "SELECT b.record,r.ready,r.reservedBytes FROM site_build_resource_inputs r JOIN site_builds b ON b.id=r.id WHERE r.ready=0 AND b.terminal=0 ORDER BY b.rowid LIMIT 16",
      )
      .all()
      .map((row) => ({
        job: JSON.parse(row.record) as SiteBuild,
        ready: !!row.ready,
        reservedBytes: row.reservedBytes,
      }));
  }
  cleanup() {
    return this.db
      .query<{ record: string }, []>(
        "SELECT b.record FROM site_build_resource_inputs r JOIN site_builds b ON b.id=r.id WHERE r.reservedBytes>0 AND b.terminal=1 ORDER BY b.rowid LIMIT 16",
      )
      .all()
      .map((row) => JSON.parse(row.record) as SiteBuild);
  }
  released(id: string) {
    if (!terminalBuildRun(this.get(id))) throw new SiteBuildError("buildActive", 409);
    this.db.query("UPDATE site_build_resource_inputs SET reservedBytes=0 WHERE id=?").run(id);
  }
}
