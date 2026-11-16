import type { Database } from "bun:sqlite";
import { canonicalPackageJson } from "../../../shared/plugins/validation.js";
import {
  TEMPLATE_LIBRARY_LIMITS,
  templateValidationSummary,
  templateArchiveSummary,
  type TemplateDefinition,
  type TemplateDraft,
  type TemplateDraftSummary,
  type TemplateRelease,
  type TemplateReleaseSummary,
  type TemplateValidation,
} from "../../../shared/plugins/library.js";
import type { TemplateLibraryStore, InstalledPlugin } from "../ports.js";
import { PluginRegistryError } from "../errors.js";

type Row = Omit<TemplateDraft, "definition" | "manifest" | "archive" | "fixtureCount" | "validation"> & {
  definition: string;
  validation: string | null;
};
const summarySelect = `SELECT id,revision,digest,packageDigest,validation,publishedAt,updatedAt,updatedBy,
  json_extract(definition,'$.package.manifest') AS manifest,json_extract(definition,'$.archive') AS archive,
  json_array_length(definition,'$.fixtures') AS fixtureCount FROM template_drafts`;
type SummaryRow = Omit<TemplateDraftSummary, "manifest" | "archive" | "validation"> & {
  manifest: string;
  archive: string;
  validation: string | null;
};
type ReleaseRow = Omit<TemplateRelease, "definition" | "validation"> & { definition: string; validation: string };
const draft = (row: Row): TemplateDraft => {
  const definition = JSON.parse(row.definition) as TemplateDefinition;
  return {
    ...row,
    definition,
    manifest: definition.package.manifest,
    archive: definition.archive,
    fixtureCount: definition.fixtures.length,
    validation: row.validation ? JSON.parse(row.validation) : null,
  };
};
const release = (row: ReleaseRow): TemplateRelease => ({
  ...row,
  definition: JSON.parse(row.definition),
  validation: JSON.parse(row.validation),
});

/** Draft edits replace bounded data; publishing commits the registry and immutable archive in one transaction. */
export class SqliteTemplateLibrary implements TemplateLibraryStore {
  constructor(private db: Database) {}
  snapshot() {
    return this.db.transaction(() => ({
      drafts: this.db
        .query<SummaryRow, []>(summarySelect + " ORDER BY updatedAt DESC,id")
        .all()
        .map((row) => ({
          ...row,
          manifest: JSON.parse(row.manifest),
          archive: templateArchiveSummary(JSON.parse(row.archive)),
          validation: row.validation ? templateValidationSummary(JSON.parse(row.validation)) : null,
        })),
      releases: this.db
        .query<
          Omit<TemplateReleaseSummary, "manifest" | "archive" | "validation"> & {
            manifest: string;
            archive: string;
            validation: string;
          },
          []
        >(
          `SELECT id,version,digest,packageDigest,validation,publishedAt,publishedBy,json_extract(definition,'$.package.manifest') AS manifest,json_extract(definition,'$.archive') AS archive FROM template_releases ORDER BY publishedAt DESC,id,version LIMIT 200`,
        )
        .all()
        .map((row) => ({
          ...row,
          manifest: JSON.parse(row.manifest),
          archive: templateArchiveSummary(JSON.parse(row.archive)),
          validation: templateValidationSummary(JSON.parse(row.validation)),
        })),
    }))();
  }
  get(id: string) {
    const row = this.db.query<Row, [string]>("SELECT * FROM template_drafts WHERE id=?").get(id);
    if (!row) throw new PluginRegistryError("libraryNotFound");
    return draft(row);
  }
  save(
    definition: TemplateDefinition,
    digest: string,
    packageDigest: string,
    id: string,
    revision: number | null,
    actor: string,
    now: number,
  ) {
    return this.db
      .transaction(() => {
        let previous: TemplateDraft | undefined;
        if (revision !== null) previous = this.mutable(id, revision);
        const json = canonicalPackageJson(definition),
          bytes = Buffer.byteLength(json),
          total = this.db
            .query<{ bytes: number; count: number }, []>(
              "SELECT coalesce(sum(length(CAST(definition AS BLOB))),0) AS bytes,count(*) AS count FROM template_drafts",
            )
            .get()!;
        const oldBytes = previous ? Buffer.byteLength(canonicalPackageJson(previous.definition)) : 0;
        if (
          total.bytes - oldBytes + bytes > TEMPLATE_LIBRARY_LIMITS.draftBytes ||
          (revision === null && total.count >= TEMPLATE_LIBRARY_LIMITS.drafts)
        )
          throw new PluginRegistryError("libraryStorageFull");
        if (revision === null)
          this.db
            .query("INSERT INTO template_drafts VALUES (?,1,?,?,?,NULL,NULL,?,?)")
            .run(id, json, digest, packageDigest, now, actor);
        else
          this.db
            .query(
              "UPDATE template_drafts SET revision=revision+1,definition=?,digest=?,packageDigest=?,validation=NULL,updatedAt=?,updatedBy=? WHERE id=?",
            )
            .run(json, digest, packageDigest, now, actor, id);
        this.audit(id, revision === null ? "create" : "save", actor, now);
        return this.get(id);
      })
      .immediate();
  }
  validate(id: string, revision: number, report: TemplateValidation, actor: string, now: number) {
    return this.db
      .transaction(() => {
        const value = this.mutable(id, revision);
        if (value.digest !== report.definitionDigest) throw new PluginRegistryError("libraryConflict");
        this.db
          .query("UPDATE template_drafts SET revision=revision+1,validation=?,updatedAt=?,updatedBy=? WHERE id=?")
          .run(JSON.stringify(report), now, actor, id);
        this.audit(id, "validate", actor, now);
        return this.get(id);
      })
      .immediate();
  }
  publish(id: string, revision: number, digest: string, actor: string, now: number, commit: () => InstalledPlugin) {
    return this.db
      .transaction(() => {
        const value = this.mutable(id, revision);
        if (value.digest !== digest || !value.validation?.passed || value.validation.definitionDigest !== digest)
          throw new PluginRegistryError("libraryUnverified");
        const manifest = value.definition.package.manifest,
          json = canonicalPackageJson(value.definition),
          prior = this.db
            .query<{ digest: string }, [string, string]>(
              "SELECT digest FROM template_releases WHERE id=? AND version=?",
            )
            .get(manifest.id, manifest.version);
        if (prior && prior.digest !== digest) throw new PluginRegistryError("immutableVersion");
        const total = this.db
          .query<{ bytes: number }, []>(
            "SELECT coalesce(sum(length(CAST(definition AS BLOB))),0) AS bytes FROM template_releases",
          )
          .get()!.bytes;
        if (!prior && total + Buffer.byteLength(json) > TEMPLATE_LIBRARY_LIMITS.releaseBytes)
          throw new PluginRegistryError("libraryStorageFull");
        const installed = commit();
        if (
          installed.id !== manifest.id ||
          installed.version !== manifest.version ||
          installed.digest !== value.packageDigest
        )
          throw new PluginRegistryError("reviewChanged");
        if (!prior)
          this.db
            .query("INSERT INTO template_releases VALUES (?,?,?,?,?,?,?,?)")
            .run(
              manifest.id,
              manifest.version,
              digest,
              value.packageDigest,
              json,
              JSON.stringify(value.validation),
              now,
              actor,
            );
        this.db
          .query("UPDATE template_drafts SET revision=revision+1,publishedAt=?,updatedAt=?,updatedBy=? WHERE id=?")
          .run(now, now, actor, id);
        this.audit(id, "publish", actor, now);
        return this.release(manifest.id, manifest.version);
      })
      .immediate();
  }
  release(id: string, version: string) {
    const row = this.db
      .query<ReleaseRow, [string, string]>("SELECT * FROM template_releases WHERE id=? AND version=?")
      .get(id, version);
    if (!row) throw new PluginRegistryError("libraryNotFound");
    return release(row);
  }
  remove(id: string, revision: number, actor: string, now: number) {
    this.db
      .transaction(() => {
        const value = this.get(id);
        if (value.revision !== revision) throw new PluginRegistryError("libraryConflict");
        if (
          value.publishedAt !== null &&
          this.release(value.manifest.id, value.manifest.version).digest !== value.digest
        )
          throw new PluginRegistryError("libraryConflict");
        this.audit(id, "delete", actor, now);
        this.db.query("DELETE FROM template_drafts WHERE id=?").run(id);
      })
      .immediate();
  }
  private mutable(id: string, revision: number) {
    const value = this.get(id);
    if (value.revision !== revision) throw new PluginRegistryError("libraryConflict");
    if (value.publishedAt !== null) throw new PluginRegistryError("libraryPublished");
    return value;
  }
  private audit(id: string, action: string, actor: string, now: number) {
    const value = this.get(id);
    this.db
      .query("INSERT INTO template_library_audit(draftId,revision,action,digest,actor,createdAt) VALUES (?,?,?,?,?,?)")
      .run(id, value.revision, action, value.digest, actor, now);
  }
}
