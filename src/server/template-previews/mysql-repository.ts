import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { MySQLLedger, type AsyncStore } from "../packages/mysql-ledger.js";
import type { TemplatePreviewJobs } from "./ports.js";
import type { TemplatePreviewJob } from "../../shared/template-previews/contracts.js";
import { TemplatePreviewError } from "./errors.js";
interface Row {
  id: string;
  owner: string;
  cacheKey: string;
  record: string;
  phase: TemplatePreviewJob["phase"];
  token: string | null;
  until: number;
}
function job(row: Row): TemplatePreviewJob {
  const value = JSON.parse(row.record) as TemplatePreviewJob;
  if (value.id !== row.id || value.key !== row.cacheKey || value.phase !== row.phase)
    throw new TemplatePreviewError("unavailable");
  return value;
}
/** The existing bounded receipt remains a receipt; an explicit phase column indexes the durable queue. */
export class MySQLTemplatePreviews extends MySQLLedger implements AsyncStore<TemplatePreviewJobs> {
  constructor(
    pool: SQL,
    private now = Date.now,
  ) {
    super(pool, "panda_force_template_previews_guard", ["until", "n"]);
  }
  private row(id: string) {
    return this.query<Row, [string]>("SELECT * FROM panda_force_template_previews WHERE id=?").get(id);
  }
  async get(owner: string, id: string) {
    return this.readSnapshot(async () => {
      const row = await this.row(id);
      if (!row || row.owner !== owner) throw new TemplatePreviewError("notFound");
      return job(row);
    });
  }
  async lookup(owner: string, key: string) {
    return this.readSnapshot(async () => {
      const row = await this.query<Row, [string, string]>(
        "SELECT * FROM panda_force_template_previews WHERE owner=? AND cacheKey=?",
      ).get(owner, key);
      return row ? job(row) : null;
    });
  }
  async reserve(owner: string, input: TemplatePreviewJob) {
    return this.transaction(async () => {
      const existing = await this.row(input.id);
      if (existing) {
        if (existing.owner !== owner) throw new TemplatePreviewError("notFound");
        if (existing.cacheKey !== input.key) throw new TemplatePreviewError("conflict");
        return job(existing);
      }
      const previous = await this.lookup(owner, input.key);
      if (previous) return previous;
      const total = (await this.query<{ n: number }, []>(
        "SELECT count(*) AS n FROM panda_force_template_previews",
      ).get())!.n;
      const active = (await this.query<{ n: number }, []>(
        "SELECT count(*) AS n FROM panda_force_template_previews WHERE phase NOT IN ('failed','ready')",
      ).get())!.n;
      if (total >= 2000 || active >= 16) throw new TemplatePreviewError("busy");
      await this.query(
        "INSERT INTO panda_force_template_previews(id,owner,cacheKey,record,phase) VALUES(?,?,?,?,?)",
      ).run(input.id, owner, input.key, JSON.stringify(input), input.phase);
      return input;
    });
  }
  async claim() {
    return this.transaction(async () => {
      const row = await this.query<Row, [number]>(
        "SELECT * FROM panda_force_template_previews WHERE `until`<=? AND phase IN ('queued','building','rendering') ORDER BY sequence LIMIT 1",
      ).get(this.now());
      if (!row) return null;
      const token = randomUUID();
      await this.query("UPDATE panda_force_template_previews SET token=?,`until`=? WHERE id=?").run(
        token,
        this.now() + 90000,
        row.id,
      );
      return { owner: row.owner, job: job(row), token };
    });
  }
  async progress(id: string, token: string, phase: "building" | "rendering") {
    await this.transaction(async () => {
      const row = await this.row(id);
      if (!row || row.token !== token) throw new TemplatePreviewError("conflict");
      const value = { ...job(row), phase, updatedAt: this.now() };
      await this.query(
        "UPDATE panda_force_template_previews SET record=?,phase=?,`until`=? WHERE id=? AND token=?",
      ).run(JSON.stringify(value), phase, this.now() + 90000, id, token);
    });
  }
  async save(id: string, token: string, changes: Parameters<TemplatePreviewJobs["save"]>[2], delay = 0) {
    return this.transaction(async () => {
      const row = await this.row(id);
      if (!row || row.token !== token) throw new TemplatePreviewError("conflict");
      const value = { ...job(row), ...changes, updatedAt: this.now() };
      await this.query(
        "UPDATE panda_force_template_previews SET record=?,phase=?,token=NULL,`until`=? WHERE id=? AND token=?",
      ).run(JSON.stringify(value), value.phase, this.now() + delay, id, token);
      return value;
    });
  }
  async retry(owner: string, id: string) {
    return this.transaction(async () => {
      const value = await this.get(owner, id);
      if (!["ready", "failed"].includes(value.phase)) return value;
      const next = {
        ...value,
        phase: "queued" as const,
        images: {},
        failure: null,
        attempts: 0,
        generation: value.generation + 1,
        updatedAt: this.now(),
      };
      await this.query(
        "UPDATE panda_force_template_previews SET record=?,phase='queued',token=NULL,`until`=0 WHERE id=?",
      ).run(JSON.stringify(next), id);
      return next;
    });
  }
}
