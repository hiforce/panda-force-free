import type { Database } from "bun:sqlite";
import type {
  InstalledPortableTemplate,
  PortableInstallReceipt,
  PortableRegistrySnapshot,
  PortableTemplateOrigin,
} from "../../../shared/templates/portable/registry.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import { validatePortableTemplateManifest } from "../../../shared/templates/portable/manifest.js";
import { portableTemplateOrigin } from "../../../shared/templates/portable/origin.js";
import type { PortableRegistryMutation, PortableRegistryStore } from "../portable/ports.js";
import { PortableRegistryError } from "../portable/errors.js";

type Row = Omit<InstalledPortableTemplate, "manifest" | "origin" | "enabled" | "active"> & {
  manifest: string;
  origin: string;
  enabled: number;
  active: number;
};
const select = `SELECT v.*,CASE WHEN h.version=v.version THEN 1 ELSE 0 END AS active FROM portable_template_versions v LEFT JOIN portable_template_heads h ON h.id=v.id`;
function record(row: Row): InstalledPortableTemplate {
  try {
    const manifest = validatePortableTemplateManifest(JSON.parse(row.manifest));
    if (manifest.id !== row.id || manifest.version !== row.version || !/^[a-f0-9]{64}$/.test(row.digest))
      throw new PortableRegistryError("unavailable");
    return {
      ...row,
      manifest,
      origin: portableTemplateOrigin(JSON.parse(row.origin)),
      enabled: row.enabled === 1,
      active: row.active === 1,
    };
  } catch {
    throw new PortableRegistryError("unavailable");
  }
}
export class SqlitePortableTemplates implements PortableRegistryStore {
  constructor(private db: Database) {}
  private revision() {
    return this.db.query<{ revision: number }, []>("SELECT revision FROM portable_template_registry WHERE id=1").get()!
      .revision;
  }
  private get(id: string, version: string) {
    const row = this.db.query<Row, [string, string]>(select + " WHERE v.id=? AND v.version=?").get(id, version);
    if (!row) throw new PortableRegistryError("notInstalled");
    return record(row);
  }
  snapshot(): PortableRegistrySnapshot {
    return this.db.transaction(() => ({
      revision: this.revision(),
      templates: this.db
        .query<Row, []>(select + " ORDER BY v.id,v.version")
        .all()
        .map(record),
    }))();
  }
  detail(id: string, version: string) {
    return this.db.transaction(() => ({ revision: this.revision(), template: this.get(id, version) }))();
  }
  replay(actor: string, operationId: string, request: string): PortableInstallReceipt | null {
    const operation = this.operation(actor, operationId);
    if (!operation) return null;
    if (operation.request !== request) throw new PortableRegistryError("operationConflict");
    return operation.receipt;
  }
  operation(actor: string, operationId: string) {
    const row = this.db
      .query<{ request: string; receipt: string }, [string, string]>(
        "SELECT request,receipt FROM portable_template_operations WHERE actor=? AND operationId=?",
      )
      .get(actor, operationId);
    if (!row) return null;
    return { request: row.request, receipt: JSON.parse(row.receipt) as PortableInstallReceipt };
  }
  install(
    templates: readonly VerifiedPortableTemplate[],
    origin: PortableTemplateOrigin,
    mutation: PortableRegistryMutation,
  ): PortableInstallReceipt {
    return this.db
      .transaction(() => {
        const replay = this.replay(mutation.actor, mutation.operationId, mutation.request);
        if (replay) return replay;
        this.check(mutation.expectedRevision);
        if (origin.kind === "authoring") {
          const draft = this.db
            .query<{ revision: number; digest: string; removed: number }, [string, string]>(
              "SELECT revision,digest,removed FROM portable_template_drafts WHERE id=? AND owner=?",
            )
            .get(origin.draftId, mutation.actor);
          if (
            !draft ||
            draft.removed ||
            draft.revision !== origin.revision ||
            draft.digest !== origin.digest ||
            templates.length !== 1 ||
            templates[0]!.digest !== origin.digest
          )
            throw new PortableRegistryError("draftConflict");
        }
        const sizes = this.db
          .query<{ count: number; bytes: number }, []>(
            "SELECT count(*) AS count,COALESCE(sum(length(CAST(manifest AS BLOB))),0) AS bytes FROM portable_template_versions",
          )
          .get()!;
        const results: PortableInstallReceipt["results"] = [];
        for (const value of templates) {
          const manifest = value.manifest;
          const prior = this.db
            .query<{ digest: string }, [string, string]>(
              "SELECT digest FROM portable_template_versions WHERE id=? AND version=?",
            )
            .get(manifest.id, manifest.version);
          if (prior && prior.digest !== value.digest) throw new PortableRegistryError("immutableVersion");
          if (prior) {
            results.push({ id: manifest.id, version: manifest.version, digest: value.digest, status: "retained" });
            continue;
          }
          const metadata = JSON.stringify(manifest);
          sizes.count++;
          sizes.bytes += Buffer.byteLength(metadata);
          if (sizes.count > 1024 || sizes.bytes > 64 * 1024 * 1024) throw new PortableRegistryError("storageFull");
          const lineage = this.db
            .query<{ count: number }, [string]>("SELECT count(*) AS count FROM portable_template_versions WHERE id=?")
            .get(manifest.id)!;
          this.db
            .query("INSERT INTO portable_template_versions VALUES(?,?,?,?,?,1,?,?)")
            .run(
              manifest.id,
              manifest.version,
              value.digest,
              metadata,
              JSON.stringify(origin),
              mutation.now,
              mutation.actor,
            );
          if (!lineage.count) this.head(manifest.id, manifest.version);
          this.audit(
            "install",
            { id: manifest.id, version: manifest.version, digest: value.digest },
            mutation.actor,
            mutation.now,
          );
          results.push({ id: manifest.id, version: manifest.version, digest: value.digest, status: "installed" });
        }
        const receipt: PortableInstallReceipt = {
          operationId: mutation.operationId,
          revision: this.revision(),
          source: origin,
          results,
        };
        this.db
          .query("INSERT INTO portable_template_operations VALUES(?,?,?,?,?)")
          .run(mutation.actor, mutation.operationId, mutation.request, JSON.stringify(receipt), mutation.now);
        return receipt;
      })
      .immediate();
  }
  state(
    id: string,
    version: string,
    action: "enable" | "disable" | "activate",
    actor: string,
    expectedRevision: number,
    now: number,
  ) {
    return this.db
      .transaction(() => {
        this.check(expectedRevision);
        const value = this.get(id, version);
        if (action === "activate") {
          if (!value.enabled) throw new PortableRegistryError("templateDisabled");
          if (value.active) return value;
          this.head(id, version);
        } else {
          const enabled = action === "enable";
          if (value.enabled === enabled) return value;
          this.db
            .query("UPDATE portable_template_versions SET enabled=? WHERE id=? AND version=?")
            .run(enabled ? 1 : 0, id, version);
          if (!enabled) this.db.query("DELETE FROM portable_template_heads WHERE id=? AND version=?").run(id, version);
        }
        this.audit(action, value, actor, now);
        return this.get(id, version);
      })
      .immediate();
  }
  private check(expectedRevision: number) {
    if (this.revision() !== expectedRevision) throw new PortableRegistryError("registryConflict");
  }
  private head(id: string, version: string) {
    this.db
      .query("INSERT INTO portable_template_heads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version")
      .run(id, version);
  }
  private audit(action: string, value: { id: string; version: string; digest: string }, actor: string, now: number) {
    this.db.query("UPDATE portable_template_registry SET revision=revision+1 WHERE id=1").run();
    this.db
      .query(
        "INSERT INTO portable_template_audit(revision,action,id,version,digest,actor,createdAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(this.revision(), action, value.id, value.version, value.digest, actor, now);
  }
}
