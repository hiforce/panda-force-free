import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { TemplatePreviewJob } from "../../shared/template-previews/contracts.js";
import { TemplatePreviewError } from "./errors.js";
interface Row {
  id: string;
  owner: string;
  cacheKey: string;
  record: string;
  token: string | null;
  until: number;
}
/** SQLite stores bounded job receipts only. Raster bytes stay in the file cache, independently of project documents. */
export class TemplatePreviewRepository {
  readonly db: Database;
  constructor(
    path: string,
    private readonly now = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS template_previews(id TEXT PRIMARY KEY,owner TEXT NOT NULL,cacheKey TEXT NOT NULL,record TEXT NOT NULL,token TEXT,until INTEGER NOT NULL DEFAULT 0,UNIQUE(owner,cacheKey))",
    );
  }
  private row(id: string) {
    return this.db.query<Row, [string]>("SELECT * FROM template_previews WHERE id=?").get(id);
  }
  get(owner: string, id: string): TemplatePreviewJob {
    const row = this.row(id);
    if (!row || row.owner !== owner) throw new TemplatePreviewError("notFound");
    return JSON.parse(row.record);
  }
  lookup(owner: string, key: string): TemplatePreviewJob | null {
    const row = this.db
      .query<Row, [string, string]>("SELECT * FROM template_previews WHERE owner=? AND cacheKey=?")
      .get(owner, key);
    return row ? JSON.parse(row.record) : null;
  }
  reserve(owner: string, input: TemplatePreviewJob) {
    return this.db
      .transaction(() => {
        const byId = this.row(input.id);
        if (byId) {
          if (byId.owner !== owner) throw new TemplatePreviewError("notFound");
          if (byId.cacheKey !== input.key) throw new TemplatePreviewError("conflict");
          return JSON.parse(byId.record) as TemplatePreviewJob;
        }
        const prior = this.lookup(owner, input.key);
        if (prior) return prior;
        if (this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM template_previews").get()!.n >= 2000)
          throw new TemplatePreviewError("busy");
        if (
          this.db
            .query<{ n: number }, []>(
              "SELECT count(*) AS n FROM template_previews WHERE json_extract(record,'$.phase') NOT IN ('failed','ready')",
            )
            .get()!.n >= 16
        )
          throw new TemplatePreviewError("busy");
        this.db
          .query("INSERT INTO template_previews(id,owner,cacheKey,record) VALUES(?,?,?,?)")
          .run(input.id, owner, input.key, JSON.stringify(input));
        return input;
      })
      .immediate();
  }
  claim() {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<Row, [number]>(
            "SELECT * FROM template_previews WHERE until<=? AND json_extract(record,'$.phase') IN ('queued','building','rendering') ORDER BY rowid LIMIT 1",
          )
          .get(this.now());
        if (!row) return null;
        const token = randomUUID();
        this.db.query("UPDATE template_previews SET token=?,until=? WHERE id=?").run(token, this.now() + 90000, row.id);
        return { owner: row.owner, job: JSON.parse(row.record) as TemplatePreviewJob, token };
      })
      .immediate();
  }
  progress(id: string, token: string, phase: "building" | "rendering") {
    const row = this.row(id);
    if (!row || row.token !== token) throw new TemplatePreviewError("conflict");
    const job = { ...JSON.parse(row.record), phase, updatedAt: this.now() };
    this.db
      .query("UPDATE template_previews SET record=?,until=? WHERE id=? AND token=?")
      .run(JSON.stringify(job), this.now() + 90000, id, token);
  }
  save(
    id: string,
    token: string,
    changes: Partial<Pick<TemplatePreviewJob, "phase" | "images" | "failure" | "attempts">>,
    delay = 0,
  ) {
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (!row || row.token !== token) throw new TemplatePreviewError("conflict");
        const job = { ...JSON.parse(row.record), ...changes, updatedAt: this.now() } as TemplatePreviewJob;
        this.db
          .query("UPDATE template_previews SET record=?,token=NULL,until=? WHERE id=? AND token=?")
          .run(JSON.stringify(job), this.now() + delay, id, token);
        return job;
      })
      .immediate();
  }
  retry(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const job = this.get(owner, id);
        if (!["ready", "failed"].includes(job.phase)) return job;
        const next = {
          ...job,
          phase: "queued" as const,
          images: {},
          failure: null,
          attempts: 0,
          generation: job.generation + 1,
          updatedAt: this.now(),
        };
        this.db
          .query("UPDATE template_previews SET record=?,token=NULL,until=0 WHERE id=?")
          .run(JSON.stringify(next), id);
        return next;
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
