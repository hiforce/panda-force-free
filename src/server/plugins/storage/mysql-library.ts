import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
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
  CAST(JSON_EXTRACT(definition,'$.package.manifest') AS CHAR) AS manifest,CAST(JSON_EXTRACT(definition,'$.archive') AS CHAR) AS archive,
  JSON_LENGTH(JSON_EXTRACT(definition,'$.fixtures')) AS fixtureCount FROM panda_force_template_drafts`;
type SummaryRow = Omit<TemplateDraftSummary, "manifest" | "archive" | "validation"> & {
  manifest: string;
  archive: string;
  validation: string | null;
};
type ReleaseRow = Omit<TemplateRelease, "definition" | "validation"> & {
  definition: string;
  validation: string;
};
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
export class MySQLTemplateLibrary extends MySQLLedger implements AsyncStore<TemplateLibraryStore> {
  readonly asynchronous = true;
  constructor(pool: SQL) {
    super(pool, "panda_force_plugins_guard", [
      "revision",
      "publishedAt",
      "updatedAt",
      "fixtureCount",
      "bytes",
      "count",
    ]);
  }
  async snapshot() {
    return this.readSnapshot(async () => {
      return {
        drafts: (await this.query<SummaryRow, []>(summarySelect + " ORDER BY updatedAt DESC,id").all()).map((row) => ({
          ...row,
          manifest: JSON.parse(row.manifest),
          archive: templateArchiveSummary(JSON.parse(row.archive)),
          validation: row.validation ? templateValidationSummary(JSON.parse(row.validation)) : null,
        })),
        releases: (
          await this.query<
            Omit<TemplateReleaseSummary, "manifest" | "archive" | "validation"> & {
              manifest: string;
              archive: string;
              validation: string;
            },
            []
          >(
            `SELECT id,version,digest,packageDigest,validation,publishedAt,publishedBy,CAST(JSON_EXTRACT(definition,'$.package.manifest') AS CHAR) AS manifest,CAST(JSON_EXTRACT(definition,'$.archive') AS CHAR) AS archive FROM panda_force_template_releases ORDER BY publishedAt DESC,id,version LIMIT 200`,
          ).all()
        ).map((row) => ({
          ...row,
          manifest: JSON.parse(row.manifest),
          archive: templateArchiveSummary(JSON.parse(row.archive)),
          validation: templateValidationSummary(JSON.parse(row.validation)),
        })),
      };
    });
  }
  async get(id: string) {
    return this.readSnapshot(async () => {
      const row = await this.query<Row, [string]>("SELECT * FROM panda_force_template_drafts WHERE id=?").get(id);
      if (!row) throw new PluginRegistryError("libraryNotFound");
      return draft(row);
    });
  }
  async save(
    definition: TemplateDefinition,
    digest: string,
    packageDigest: string,
    id: string,
    revision: number | null,
    actor: string,
    now: number,
  ) {
    return this.transaction(async () => {
      let previous: TemplateDraft | undefined;
      if (revision !== null) previous = await this.mutable(id, revision);
      const json = canonicalPackageJson(definition),
        bytes = Buffer.byteLength(json),
        total = (await this.query<
          {
            bytes: number;
            count: number;
          },
          []
        >(
          "SELECT coalesce(sum(OCTET_LENGTH(definition)),0) AS bytes,count(*) AS count FROM panda_force_template_drafts",
        ).get())!;
      const oldBytes = previous ? Buffer.byteLength(canonicalPackageJson(previous.definition)) : 0;
      if (
        total.bytes - oldBytes + bytes > TEMPLATE_LIBRARY_LIMITS.draftBytes ||
        (revision === null && total.count >= TEMPLATE_LIBRARY_LIMITS.drafts)
      )
        throw new PluginRegistryError("libraryStorageFull");
      if (revision === null)
        await this.query("INSERT INTO panda_force_template_drafts VALUES (?,1,?,?,?,NULL,NULL,?,?)").run(
          id,
          json,
          digest,
          packageDigest,
          now,
          actor,
        );
      else
        await this.query(
          "UPDATE panda_force_template_drafts SET revision=revision+1,definition=?,digest=?,packageDigest=?,validation=NULL,updatedAt=?,updatedBy=? WHERE id=?",
        ).run(json, digest, packageDigest, now, actor, id);
      await this.audit(id, revision === null ? "create" : "save", actor, now);
      return await this.get(id);
    });
  }
  async validate(id: string, revision: number, report: TemplateValidation, actor: string, now: number) {
    return this.transaction(async () => {
      const value = await this.mutable(id, revision);
      if (value.digest !== report.definitionDigest) throw new PluginRegistryError("libraryConflict");
      await this.query(
        "UPDATE panda_force_template_drafts SET revision=revision+1,validation=?,updatedAt=?,updatedBy=? WHERE id=?",
      ).run(JSON.stringify(report), now, actor, id);
      await this.audit(id, "validate", actor, now);
      return await this.get(id);
    });
  }
  async publish(
    id: string,
    revision: number,
    digest: string,
    actor: string,
    now: number,
    commit: () => InstalledPlugin | Promise<InstalledPlugin>,
  ) {
    return this.transaction(async () => {
      const value = await this.mutable(id, revision);
      if (value.digest !== digest || !value.validation?.passed || value.validation.definitionDigest !== digest)
        throw new PluginRegistryError("libraryUnverified");
      const manifest = value.definition.package.manifest,
        json = canonicalPackageJson(value.definition),
        prior = await this.query<
          {
            digest: string;
          },
          [string, string]
        >("SELECT digest FROM panda_force_template_releases WHERE id=? AND version=?").get(
          manifest.id,
          manifest.version,
        );
      if (prior && prior.digest !== digest) throw new PluginRegistryError("immutableVersion");
      const total = (await this.query<
        {
          bytes: number;
        },
        []
      >("SELECT coalesce(sum(OCTET_LENGTH(definition)),0) AS bytes FROM panda_force_template_releases").get())!.bytes;
      if (!prior && total + Buffer.byteLength(json) > TEMPLATE_LIBRARY_LIMITS.releaseBytes)
        throw new PluginRegistryError("libraryStorageFull");
      const installed = await commit();
      if (
        installed.id !== manifest.id ||
        installed.version !== manifest.version ||
        installed.digest !== value.packageDigest
      )
        throw new PluginRegistryError("reviewChanged");
      if (!prior)
        await this.query("INSERT INTO panda_force_template_releases VALUES (?,?,?,?,?,?,?,?)").run(
          manifest.id,
          manifest.version,
          digest,
          value.packageDigest,
          json,
          JSON.stringify(value.validation),
          now,
          actor,
        );
      await this.query(
        "UPDATE panda_force_template_drafts SET revision=revision+1,publishedAt=?,updatedAt=?,updatedBy=? WHERE id=?",
      ).run(now, now, actor, id);
      await this.audit(id, "publish", actor, now);
      return await this.release(manifest.id, manifest.version);
    });
  }
  async release(id: string, version: string) {
    return this.readSnapshot(async () => {
      const row = await this.query<ReleaseRow, [string, string]>(
        "SELECT * FROM panda_force_template_releases WHERE id=? AND version=?",
      ).get(id, version);
      if (!row) throw new PluginRegistryError("libraryNotFound");
      return release(row);
    });
  }
  async remove(id: string, revision: number, actor: string, now: number) {
    return this.transaction(async () => {
      const value = await this.get(id);
      if (value.revision !== revision) throw new PluginRegistryError("libraryConflict");
      if (
        value.publishedAt !== null &&
        (await this.release(value.manifest.id, value.manifest.version)).digest !== value.digest
      )
        throw new PluginRegistryError("libraryConflict");
      await this.audit(id, "delete", actor, now);
      await this.query("DELETE FROM panda_force_template_drafts WHERE id=?").run(id);
    });
  }
  private async mutable(id: string, revision: number) {
    const value = await this.get(id);
    if (value.revision !== revision) throw new PluginRegistryError("libraryConflict");
    if (value.publishedAt !== null) throw new PluginRegistryError("libraryPublished");
    return value;
  }
  private async audit(id: string, action: string, actor: string, now: number) {
    const value = await this.get(id);
    await this.query(
      "INSERT INTO panda_force_template_library_audit(draftId,revision,action,digest,actor,createdAt) VALUES (?,?,?,?,?,?)",
    ).run(id, value.revision, action, value.digest, actor, now);
  }
}
