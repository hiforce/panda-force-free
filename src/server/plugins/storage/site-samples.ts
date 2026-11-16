import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { BuildInput } from "../../../shared/builds/contracts.js";
import { terminalBuildRun, type BuildRunChanges } from "../../../shared/builds/run.js";
import { buildThemeMetadata } from "../../../shared/builds/theme.js";
import type { SiteSampleBuild, SiteSampleRequest } from "../../../shared/plugins/site-samples.js";
import { utf8Prefix } from "../../../shared/utf8.js";
import { PluginRegistryError } from "../errors.js";
import type { SiteSampleCapture, SiteSampleStore } from "../ports.js";

const inputHash = (input: BuildInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const mutable: (keyof BuildRunChanges)[] = [
  "phase",
  "connection",
  "error",
  "image",
  "outputBytes",
  "fileCount",
  "artifactAvailable",
];

/** Only execution receipts live here; project documents, source originals and attachments are never copied into SQL. */
export class SqliteSiteSamples implements SiteSampleStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  existing(request: SiteSampleRequest, actor: string): SiteSampleBuild | null {
    const row = this.db
      .query<{ owner: string; request: string; record: string }, [string]>(
        "SELECT owner,request,record FROM site_sample_runs WHERE id=?",
      )
      .get(request.id);
    if (!row) return null;
    if (row.owner !== actor) throw new PluginRegistryError("sampleNotFound");
    if (row.request !== JSON.stringify(request)) throw new PluginRegistryError("sampleConflict");
    return JSON.parse(row.record);
  }
  create(request: SiteSampleRequest, capture: SiteSampleCapture, actor: string) {
    return this.db
      .transaction(() => {
        const previous = this.existing(request, actor);
        if (previous) return previous;
        if (this.active().length >= 4) throw new PluginRegistryError("sampleBusy");
        if (this.db.query<{ total: number }, []>("SELECT count(*) AS total FROM site_sample_runs").get()!.total >= 1000)
          throw new PluginRegistryError("libraryStorageFull");
        const { input, context, key } = capture,
          now = this.now();
        const job: SiteSampleBuild = {
          id: request.id,
          key,
          context,
          theme: buildThemeMetadata(input.theme),
          site: input.site,
          engine: input.engine,
          inputHash: inputHash(input),
          phase: "queued",
          createdAt: now,
          updatedAt: now,
          error: null,
          connection: "ready",
          outputBytes: 0,
          fileCount: 0,
          artifactAvailable: false,
          image: null,
        };
        this.db
          .query(
            "INSERT INTO site_sample_runs(id,owner,sampleKey,request,record,input,createdAt) VALUES(?,?,?,?,?,?,?)",
          )
          .run(job.id, actor, key, JSON.stringify(request), JSON.stringify(job), JSON.stringify(input), now);
        return structuredClone(job);
      })
      .immediate();
  }
  owner(id: string) {
    const row = this.db.query<{ owner: string }, [string]>("SELECT owner FROM site_sample_runs WHERE id=?").get(id);
    if (!row) throw new PluginRegistryError("sampleNotFound");
    return row.owner;
  }
  get(id: string): SiteSampleBuild {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM site_sample_runs WHERE id=?").get(id);
    if (!row) throw new PluginRegistryError("sampleNotFound");
    return JSON.parse(row.record);
  }
  input(id: string): BuildInput {
    const row = this.db
      .query<{ input: string | null }, [string]>("SELECT input FROM site_sample_runs WHERE id=?")
      .get(id);
    if (!row?.input) throw new PluginRegistryError("sampleArtifactUnavailable");
    const input: BuildInput = JSON.parse(row.input);
    if (inputHash(input) !== this.get(id).inputHash) throw new PluginRegistryError("sampleArtifactUnavailable");
    return input;
  }
  update(id: string, changes: BuildRunChanges): SiteSampleBuild {
    return this.db
      .transaction(() => {
        const job = this.get(id),
          safe = Object.fromEntries(
            Object.entries(changes).filter(([key]) => mutable.includes(key as keyof BuildRunChanges)),
          );
        const next = { ...job, ...safe, updatedAt: this.now() } as SiteSampleBuild;
        const terminal = Number(terminalBuildRun(next));
        this.db
          .query(
            "UPDATE site_sample_runs SET record=?,terminal=?,input=CASE WHEN ?=1 THEN NULL ELSE input END WHERE id=?",
          )
          .run(JSON.stringify(next), terminal, terminal, id);
        return next;
      })
      .immediate();
  }
  private records(query: string, values: string[] = []): SiteSampleBuild[] {
    return this.db
      .query<{ record: string }, string[]>(query)
      .all(...values)
      .map((row) => JSON.parse(row.record));
  }
  active() {
    return this.records("SELECT record FROM site_sample_runs WHERE terminal=0 ORDER BY rowid");
  }
  artifacts() {
    return this.records("SELECT record FROM site_sample_runs WHERE terminal=1 ORDER BY rowid DESC").filter(
      (job) => job.artifactAvailable,
    );
  }
  list(actor: string) {
    return this.records("SELECT record FROM site_sample_runs WHERE owner=? ORDER BY rowid DESC LIMIT 100", [actor]);
  }
  latest(key: string, actor?: string) {
    if (actor !== undefined)
      return (
        this.records("SELECT record FROM site_sample_runs WHERE sampleKey=? AND owner=? ORDER BY rowid DESC LIMIT 1", [
          key,
          actor,
        ])[0] || null
      );
    return (
      this.records("SELECT record FROM site_sample_runs WHERE sampleKey=? ORDER BY rowid DESC LIMIT 1", [key])[0] ||
      null
    );
  }
  logs(id: string) {
    this.get(id);
    return this.db.query<{ logs: string }, [string]>("SELECT logs FROM site_sample_runs WHERE id=?").get(id)!.logs;
  }
  saveLogs(id: string, text: string) {
    this.db.query("UPDATE site_sample_runs SET logs=? WHERE id=?").run(utf8Prefix(text, 128 * 1024), id);
  }
  remove(id: string) {
    if (!terminalBuildRun(this.get(id))) throw new PluginRegistryError("sampleConflict");
    this.db.query("DELETE FROM site_sample_runs WHERE id=?").run(id);
  }
}
