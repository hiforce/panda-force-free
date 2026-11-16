import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
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
export class MySQLSiteSamples extends MySQLLedger implements AsyncStore<SiteSampleStore> {
  constructor(
    pool: SQL,
    private now = Date.now,
  ) {
    super(pool, "panda_force_plugins_guard", ["createdAt", "terminal", "active", "total", "owned", "visible"]);
  }
  async existing(request: SiteSampleRequest, actor: string): Promise<SiteSampleBuild | null> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          owner: string;
          request: string;
          record: string;
        },
        [string]
      >("SELECT owner,request,record FROM panda_force_site_sample_runs WHERE id=?").get(request.id);
      if (!row) return null;
      if (row.owner !== actor) throw new PluginRegistryError("sampleNotFound");
      if (row.request !== JSON.stringify(request)) throw new PluginRegistryError("sampleConflict");
      return JSON.parse(row.record);
    });
  }
  async create(request: SiteSampleRequest, capture: SiteSampleCapture, actor: string) {
    return this.transaction(async () => {
      const previous = await this.existing(request, actor);
      if (previous) return previous;
      if ((await this.active()).length >= 4) throw new PluginRegistryError("sampleBusy");
      if (
        (await this.query<
          {
            total: number;
          },
          []
        >("SELECT count(*) AS total FROM panda_force_site_sample_runs").get())!.total >= 1000
      )
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
      await this.query(
        "INSERT INTO panda_force_site_sample_runs(id,owner,sampleKey,request,record,input,createdAt,logs) VALUES(?,?,?,?,?,?,?,'')",
      ).run(job.id, actor, key, JSON.stringify(request), JSON.stringify(job), JSON.stringify(input), now);
      return structuredClone(job);
    });
  }
  async owner(id: string) {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          owner: string;
        },
        [string]
      >("SELECT owner FROM panda_force_site_sample_runs WHERE id=?").get(id);
      if (!row) throw new PluginRegistryError("sampleNotFound");
      return row.owner;
    });
  }
  async get(id: string): Promise<SiteSampleBuild> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          record: string;
        },
        [string]
      >("SELECT record FROM panda_force_site_sample_runs WHERE id=?").get(id);
      if (!row) throw new PluginRegistryError("sampleNotFound");
      return JSON.parse(row.record);
    });
  }
  async input(id: string): Promise<BuildInput> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          input: string | null;
        },
        [string]
      >("SELECT input FROM panda_force_site_sample_runs WHERE id=?").get(id);
      if (!row?.input) throw new PluginRegistryError("sampleArtifactUnavailable");
      const input: BuildInput = JSON.parse(row.input);
      if (inputHash(input) !== (await this.get(id)).inputHash)
        throw new PluginRegistryError("sampleArtifactUnavailable");
      return input;
    });
  }
  async update(id: string, changes: BuildRunChanges): Promise<SiteSampleBuild> {
    return this.transaction(async () => {
      const job = await this.get(id),
        safe = Object.fromEntries(
          Object.entries(changes).filter(([key]) => mutable.includes(key as keyof BuildRunChanges)),
        );
      const next = { ...job, ...safe, updatedAt: this.now() } as SiteSampleBuild;
      const terminal = Number(terminalBuildRun(next));
      await this.query(
        "UPDATE panda_force_site_sample_runs SET record=?,terminal=?,input=CASE WHEN ?=1 THEN NULL ELSE input END WHERE id=?",
      ).run(JSON.stringify(next), terminal, terminal, id);
      return next;
    });
  }
  private async records(query: string, values: string[] = []): Promise<SiteSampleBuild[]> {
    return (
      await this.query<
        {
          record: string;
        },
        string[]
      >(query).all(...values)
    ).map((row) => JSON.parse(row.record));
  }
  async active() {
    return this.readSnapshot(async () => {
      return await this.records("SELECT record FROM panda_force_site_sample_runs WHERE terminal=0 ORDER BY sequence");
    });
  }
  async artifacts() {
    return this.readSnapshot(async () => {
      return (
        await this.records("SELECT record FROM panda_force_site_sample_runs WHERE terminal=1 ORDER BY sequence DESC")
      ).filter((job) => job.artifactAvailable);
    });
  }
  async list(actor: string) {
    return this.readSnapshot(async () => {
      return await this.records(
        "SELECT record FROM panda_force_site_sample_runs WHERE owner=? ORDER BY sequence DESC LIMIT 100",
        [actor],
      );
    });
  }
  async latest(key: string, actor?: string) {
    return this.readSnapshot(async () => {
      if (actor !== undefined)
        return (
          (
            await this.records(
              "SELECT record FROM panda_force_site_sample_runs WHERE sampleKey=? AND owner=? ORDER BY sequence DESC LIMIT 1",
              [key, actor],
            )
          )[0] || null
        );
      return (
        (
          await this.records(
            "SELECT record FROM panda_force_site_sample_runs WHERE sampleKey=? ORDER BY sequence DESC LIMIT 1",
            [key],
          )
        )[0] || null
      );
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
      >("SELECT logs FROM panda_force_site_sample_runs WHERE id=?").get(id))!.logs;
    });
  }
  async saveLogs(id: string, text: string) {
    return this.transaction(async () => {
      await this.query("UPDATE panda_force_site_sample_runs SET logs=? WHERE id=?").run(
        utf8Prefix(text, 128 * 1024),
        id,
      );
    });
  }
  async remove(id: string) {
    return this.transaction(async () => {
      if (!terminalBuildRun(await this.get(id))) throw new PluginRegistryError("sampleConflict");
      await this.query("DELETE FROM panda_force_site_sample_runs WHERE id=?").run(id);
    });
  }
}
