import type { Database } from "bun:sqlite";
import { RESOURCE_FRAME_MAX } from "../../../shared/builds/resource-frame.js";
import type { NativeSampleBuild } from "../../../shared/builds/native-samples.js";
import { terminalBuildRun, type BuildRunChanges } from "../../../shared/builds/run.js";
import { utf8Prefix } from "../../../shared/utf8.js";
import type { NativeSampleStore, NativeSampleReservation } from "./ports.js";
import { SiteBuildError } from "../errors.js";

interface Row {
  id: string;
  owner: string;
  signature: string;
  sampleKey: string;
  record: string;
  inputReady: number;
  terminal: number;
  reservedBytes: number;
  removed: number;
}
const mutable = ["phase", "connection", "error", "image", "outputBytes", "fileCount", "artifactAvailable"];
function record(row: Row): NativeSampleBuild {
  const value = JSON.parse(row.record) as NativeSampleBuild;
  if (value.id !== row.id || value.key !== row.sampleKey || terminalBuildRun(value) !== !!row.terminal)
    throw new SiteBuildError("snapshotUnavailable", 503);
  return value;
}
const reservation = (row: Row): NativeSampleReservation => ({
  job: record(row),
  ready: !!row.inputReady,
  reservedBytes: row.reservedBytes,
});

/** Preparing inputs are never dispatched. Capacity remains reserved until durable file cleanup succeeds. */
export class SqliteNativeSamples implements NativeSampleStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  private row(id: string): Row {
    const row = this.db.query<Row, [string]>("SELECT * FROM native_sample_runs WHERE id=?").get(id);
    if (!row) throw new SiteBuildError("notFound", 404);
    return row;
  }
  existing(actor: string, id: string, signature: string) {
    const row = this.db.query<Row, [string]>("SELECT * FROM native_sample_runs WHERE id=?").get(id);
    if (!row) return null;
    if (row.owner !== actor) throw new SiteBuildError("notFound", 404);
    if (row.signature !== signature) throw new SiteBuildError("idempotencyConflict", 409);
    return reservation(row);
  }
  reserve(actor: string, signature: string, job: NativeSampleBuild) {
    return this.db
      .transaction(() => {
        const previous = this.existing(actor, job.id, signature);
        if (previous) return { value: previous, created: false };
        const totals = this.db
          .query<{ total: number; visible: number; active: number; used: number; owned: number }, [string]>(
            "SELECT count(*) AS total,COALESCE(sum(removed=0),0) AS visible,COALESCE(sum(terminal=0),0) AS active,COALESCE(sum(reservedBytes),0) AS used,COALESCE(sum(CASE WHEN owner=? THEN reservedBytes ELSE 0 END),0) AS owned FROM native_sample_runs",
          )
          .get(actor)!;
        if (totals.active >= 4) throw new SiteBuildError("busy", 429);
        if (
          totals.total >= 10000 ||
          totals.visible >= 1000 ||
          totals.used + RESOURCE_FRAME_MAX > 2 * 1024 ** 3 ||
          totals.owned + RESOURCE_FRAME_MAX > 512 * 1024 ** 2
        )
          throw new SiteBuildError("storageFull", 429);
        this.db
          .query(
            "INSERT INTO native_sample_runs(id,owner,signature,sampleKey,record,reservedBytes) VALUES(?,?,?,?,?,?)",
          )
          .run(job.id, actor, signature, job.key, JSON.stringify(job), RESOURCE_FRAME_MAX);
        return { value: reservation(this.row(job.id)), created: true };
      })
      .immediate();
  }
  accept(id: string, inputHash: string, bytes: number) {
    return this.db
      .transaction(() => {
        const row = this.row(id),
          job = record(row);
        if (job.inputHash !== inputHash || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > RESOURCE_FRAME_MAX)
          throw new SiteBuildError("snapshotUnavailable", 503);
        if (row.terminal) return job;
        const next = job.phase === "cancelling" ? { ...job, phase: "cancelled" as const, updatedAt: this.now() } : job;
        this.db
          .query("UPDATE native_sample_runs SET inputReady=1,reservedBytes=?,record=?,terminal=? WHERE id=?")
          .run(bytes, JSON.stringify(next), Number(terminalBuildRun(next)), id);
        return next;
      })
      .immediate();
  }
  owner(id: string) {
    const row = this.row(id);
    if (row.removed) throw new SiteBuildError("notFound", 404);
    return row.owner;
  }
  get(id: string) {
    return record(this.row(id));
  }
  reservation(id: string) {
    return reservation(this.row(id));
  }
  private rows(where: string, parameters: string[] = []) {
    return this.db.query<Row, string[]>("SELECT * FROM native_sample_runs " + where).all(...parameters);
  }
  active() {
    return this.rows("WHERE inputReady=1 AND terminal=0 ORDER BY rowid").map(record);
  }
  artifacts() {
    return this.rows("WHERE terminal=1 AND removed=0 ORDER BY rowid DESC")
      .map(record)
      .filter((job) => job.artifactAvailable);
  }
  pending() {
    return this.rows("WHERE inputReady=0 AND terminal=0 ORDER BY rowid LIMIT 16").map(reservation);
  }
  cleanup() {
    return this.rows("WHERE terminal=1 AND reservedBytes>0 ORDER BY rowid LIMIT 16").map(record);
  }
  released(id: string) {
    this.db.query("UPDATE native_sample_runs SET reservedBytes=0 WHERE id=? AND terminal=1").run(id);
  }
  latest(actor: string, key: string) {
    const row = this.rows("WHERE owner=? AND sampleKey=? AND removed=0 ORDER BY rowid DESC LIMIT 1", [actor, key])[0];
    return row ? record(row) : null;
  }
  list(actor: string) {
    return this.rows("WHERE owner=? AND removed=0 ORDER BY rowid DESC LIMIT 100", [actor]).map(record);
  }
  update(id: string, changes: BuildRunChanges) {
    return this.db
      .transaction(() => {
        const current = this.get(id),
          safe = Object.fromEntries(Object.entries(changes).filter(([key]) => mutable.includes(key)));
        if (terminalBuildRun(current) && changes.phase && changes.phase !== current.phase)
          throw new SiteBuildError("executorConflict", 409);
        const next = { ...current, ...safe, updatedAt: this.now() } as NativeSampleBuild;
        this.db
          .query("UPDATE native_sample_runs SET record=?,terminal=? WHERE id=?")
          .run(JSON.stringify(next), Number(terminalBuildRun(next)), id);
        return next;
      })
      .immediate();
  }
  logs(id: string) {
    this.get(id);
    return this.db.query<{ logs: string }, [string]>("SELECT logs FROM native_sample_runs WHERE id=?").get(id)!.logs;
  }
  saveLogs(id: string, value: string) {
    this.db.query("UPDATE native_sample_runs SET logs=? WHERE id=?").run(utf8Prefix(value, 128 * 1024), id);
  }
  archive(id: string) {
    if (!terminalBuildRun(this.get(id))) throw new SiteBuildError("buildActive", 409);
    this.update(id, { artifactAvailable: false });
    this.db.query("UPDATE native_sample_runs SET removed=1 WHERE id=?").run(id);
  }
}
