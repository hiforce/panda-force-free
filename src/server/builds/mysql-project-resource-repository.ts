import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore, type MySQLLedgerTransaction } from "../packages/mysql-ledger.js";
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
/** Only resource metadata participates in the build ledger transaction; immutable bytes remain in owned files. */
export class MySQLProjectResourceRepository extends MySQLLedger implements AsyncStore<ResourceInputLedger<SiteBuild>> {
  constructor(
    pool: SQL,
    private records: AsyncStore<ProjectResourceRecords>,
    documentTransaction?: MySQLLedgerTransaction,
  ) {
    super(pool, "panda_force_site_builds_guard", ["ready", "reservedBytes", "used", "owned"], documentTransaction);
  }
  private async row(id: string): Promise<Row> {
    const row = await this.query<Row, [string]>("SELECT * FROM panda_force_site_build_resource_inputs WHERE id=?").get(
      id,
    );
    if (!row) throw new SiteBuildError("notFound", 404);
    return row;
  }
  async authorize(actor: string | undefined, id: string) {
    return this.readSnapshot(async () => {
      if (!actor || (await this.row(id)).owner !== actor) throw new SiteBuildError("notFound", 404);
    });
  }
  async identity(id: string) {
    return this.readSnapshot(async () => {
      const job = await this.records.stored(id);
      if (!job.nativeTheme) throw new SiteBuildError("snapshotUnavailable", 503);
      const { id: themeId, version, digest } = job.nativeTheme;
      return { actor: (await this.row(id)).owner, theme: { id: themeId, version, digest } };
    });
  }
  async reserve(
    actor: string,
    request: SiteBuildRequest,
    input: ResourceBuildRequest,
    sources: BuildSourceRevision[],
    snapshot?: SiteBuild["sourceSnapshot"],
  ) {
    return this.transaction(async () => {
      if (
        !request.nativeTheme ||
        input.engine !== request.engine ||
        input.descriptor.theme.id !== request.nativeTheme.id ||
        input.descriptor.theme.version !== request.nativeTheme.version
      )
        throw new SiteBuildError("invalidInput");
      const previous = await this.records.existing(request, actor);
      if (previous) return { value: await this.reservation(previous.id), created: false };
      const totals = (await this.query<
        {
          used: number;
          owned: number;
        },
        [string]
      >(
        "SELECT COALESCE(sum(reservedBytes),0) AS used,COALESCE(sum(CASE WHEN owner=? THEN reservedBytes ELSE 0 END),0) AS owned FROM panda_force_site_build_resource_inputs",
      ).get(actor))!;
      if (totals.used + RESOURCE_FRAME_MAX > 2 * 1024 ** 3 || totals.owned + RESOURCE_FRAME_MAX > 512 * 1024 ** 2)
        throw new SiteBuildError("storageFull", 429);
      const job = await this.records.insert(request, input, sources, snapshot);
      await this.query("INSERT INTO panda_force_site_build_resource_inputs(id,owner,reservedBytes) VALUES(?,?,?)").run(
        job.id,
        actor,
        RESOURCE_FRAME_MAX,
      );
      return { value: await this.reservation(job.id), created: true };
    });
  }
  async reservation(id: string): Promise<ResourceInputReservation<SiteBuild>> {
    return this.readSnapshot(async () => {
      const row = await this.row(id);
      return { job: await this.records.stored(id), ready: !!row.ready, reservedBytes: row.reservedBytes };
    });
  }
  async get(id: string) {
    return this.readSnapshot(async () => {
      return await this.records.stored(id);
    });
  }
  async update(id: string, changes: BuildRunChanges) {
    return this.transaction(async () => {
      return await this.records.update(id, changes);
    });
  }
  async accept(id: string, inputHash: string, bytes: number) {
    return this.transaction(async () => {
      const job = await this.records.stored(id);
      await this.row(id);
      if (job.inputHash !== inputHash || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > RESOURCE_FRAME_MAX)
        throw new SiteBuildError("snapshotUnavailable", 503);
      if (terminalBuildRun(job)) return job;
      const next = job.phase === "cancelling" ? await this.records.update(id, { phase: "cancelled" }) : job;
      await this.query("UPDATE panda_force_site_build_resource_inputs SET ready=1,reservedBytes=? WHERE id=?").run(
        bytes,
        id,
      );
      return next;
    });
  }
  async pending() {
    return this.readSnapshot(async () => {
      const rows = await this.query<{ record: string; ready: number; reservedBytes: number }, []>(
        "SELECT b.record,r.ready,r.reservedBytes FROM panda_force_site_build_resource_inputs r JOIN panda_force_site_builds b ON b.id=r.id WHERE r.ready=0 AND b.terminal=0 ORDER BY b.sequence LIMIT 16",
      ).all();
      return rows.map((row) => ({
        job: JSON.parse(row.record) as SiteBuild,
        ready: !!row.ready,
        reservedBytes: row.reservedBytes,
      }));
    });
  }
  async cleanup() {
    return this.readSnapshot(async () => {
      return (
        await this.query<{ record: string }, []>(
          "SELECT b.record FROM panda_force_site_build_resource_inputs r JOIN panda_force_site_builds b ON b.id=r.id WHERE r.reservedBytes>0 AND b.terminal=1 ORDER BY b.sequence LIMIT 16",
        ).all()
      ).map((row) => JSON.parse(row.record) as SiteBuild);
    });
  }
  async released(id: string) {
    return this.transaction(async () => {
      if (!terminalBuildRun(await this.get(id))) throw new SiteBuildError("buildActive", 409);
      await this.query("UPDATE panda_force_site_build_resource_inputs SET reservedBytes=0 WHERE id=?").run(id);
    });
  }
}
