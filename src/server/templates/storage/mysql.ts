import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
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
const select = `SELECT v.*,CASE WHEN h.version=v.version THEN 1 ELSE 0 END AS active FROM panda_force_portable_template_versions v LEFT JOIN panda_force_portable_template_heads h ON h.id=v.id`;
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
export class MySQLPortableTemplates extends MySQLLedger implements AsyncStore<PortableRegistryStore> {
  constructor(pool: SQL) {
    super(pool, "panda_force_portable_templates_guard", [
      "revision",
      "enabled",
      "active",
      "installedAt",
      "createdAt",
      "sequence",
      "bytes",
      "count",
    ]);
  }
  private async revision() {
    return (await this.query<
      {
        revision: number;
      },
      []
    >("SELECT COALESCE((SELECT revision FROM panda_force_portable_template_registry WHERE id=1),0) revision").get())!
      .revision;
  }
  private async get(id: string, version: string) {
    const row = await this.query<Row, [string, string]>(select + " WHERE v.id=? AND v.version=?").get(id, version);
    if (!row) throw new PortableRegistryError("notInstalled");
    return record(row);
  }
  async snapshot(): Promise<PortableRegistrySnapshot> {
    return this.readSnapshot(async () => {
      return {
        revision: await this.revision(),
        templates: (await this.query<Row, []>(select + " ORDER BY v.id,v.version").all()).map(record),
      };
    });
  }
  async detail(id: string, version: string) {
    return this.readSnapshot(async () => {
      return { revision: await this.revision(), template: await this.get(id, version) };
    });
  }
  async replay(actor: string, operationId: string, request: string): Promise<PortableInstallReceipt | null> {
    return this.readSnapshot(async () => {
      const operation = await this.operation(actor, operationId);
      if (!operation) return null;
      if (operation.request !== request) throw new PortableRegistryError("operationConflict");
      return operation.receipt;
    });
  }
  async operation(actor: string, operationId: string) {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          request: string;
          receipt: string;
        },
        [string, string]
      >("SELECT request,receipt FROM panda_force_portable_template_operations WHERE actor=? AND operationId=?").get(
        actor,
        operationId,
      );
      if (!row) return null;
      return { request: row.request, receipt: JSON.parse(row.receipt) as PortableInstallReceipt };
    });
  }
  async install(
    templates: readonly VerifiedPortableTemplate[],
    origin: PortableTemplateOrigin,
    mutation: PortableRegistryMutation,
  ): Promise<PortableInstallReceipt> {
    return this.transaction(async () => {
      const replay = await this.replay(mutation.actor, mutation.operationId, mutation.request);
      if (replay) return replay;
      await this.check(mutation.expectedRevision);
      if (origin.kind === "authoring") {
        const draft = await this.query<
          {
            revision: number;
            digest: string;
            removed: number;
          },
          [string, string]
        >("SELECT revision,digest,removed FROM panda_force_portable_template_drafts WHERE id=? AND owner=?").get(
          origin.draftId,
          mutation.actor,
        );
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
      const sizes = (await this.query<
        {
          count: number;
          bytes: number;
        },
        []
      >(
        "SELECT count(*) AS count,COALESCE(sum(OCTET_LENGTH(manifest)),0) AS bytes FROM panda_force_portable_template_versions",
      ).get())!;
      const results: PortableInstallReceipt["results"] = [];
      for (const value of templates) {
        const manifest = value.manifest;
        const prior = await this.query<
          {
            digest: string;
          },
          [string, string]
        >("SELECT digest FROM panda_force_portable_template_versions WHERE id=? AND version=?").get(
          manifest.id,
          manifest.version,
        );
        if (prior && prior.digest !== value.digest) throw new PortableRegistryError("immutableVersion");
        if (prior) {
          results.push({ id: manifest.id, version: manifest.version, digest: value.digest, status: "retained" });
          continue;
        }
        const metadata = JSON.stringify(manifest);
        sizes.count++;
        sizes.bytes += Buffer.byteLength(metadata);
        if (sizes.count > 1024 || sizes.bytes > 64 * 1024 * 1024) throw new PortableRegistryError("storageFull");
        const lineage = (await this.query<
          {
            count: number;
          },
          [string]
        >("SELECT count(*) AS count FROM panda_force_portable_template_versions WHERE id=?").get(manifest.id))!;
        await this.query("INSERT INTO panda_force_portable_template_versions VALUES(?,?,?,?,?,1,?,?)").run(
          manifest.id,
          manifest.version,
          value.digest,
          metadata,
          JSON.stringify(origin),
          mutation.now,
          mutation.actor,
        );
        if (!lineage.count) await this.head(manifest.id, manifest.version);
        await this.audit(
          "install",
          { id: manifest.id, version: manifest.version, digest: value.digest },
          mutation.actor,
          mutation.now,
        );
        results.push({ id: manifest.id, version: manifest.version, digest: value.digest, status: "installed" });
      }
      const receipt: PortableInstallReceipt = {
        operationId: mutation.operationId,
        revision: await this.revision(),
        source: origin,
        results,
      };
      await this.query("INSERT INTO panda_force_portable_template_operations VALUES(?,?,?,?,?)").run(
        mutation.actor,
        mutation.operationId,
        mutation.request,
        JSON.stringify(receipt),
        mutation.now,
      );
      return receipt;
    });
  }
  async state(
    id: string,
    version: string,
    action: "enable" | "disable" | "activate",
    actor: string,
    expectedRevision: number,
    now: number,
  ) {
    return this.transaction(async () => {
      await this.check(expectedRevision);
      const value = await this.get(id, version);
      if (action === "activate") {
        if (!value.enabled) throw new PortableRegistryError("templateDisabled");
        if (value.active) return value;
        await this.head(id, version);
      } else {
        const enabled = action === "enable";
        if (value.enabled === enabled) return value;
        await this.query("UPDATE panda_force_portable_template_versions SET enabled=? WHERE id=? AND version=?").run(
          enabled ? 1 : 0,
          id,
          version,
        );
        if (!enabled)
          await this.query("DELETE FROM panda_force_portable_template_heads WHERE id=? AND version=?").run(id, version);
      }
      await this.audit(action, value, actor, now);
      return await this.get(id, version);
    });
  }
  private async check(expectedRevision: number) {
    if ((await this.revision()) !== expectedRevision) throw new PortableRegistryError("registryConflict");
  }
  private async head(id: string, version: string) {
    await this.query(
      "INSERT INTO panda_force_portable_template_heads VALUES(?,?) ON DUPLICATE KEY UPDATE version=VALUES(version)",
    ).run(id, version);
  }
  private async audit(
    action: string,
    value: {
      id: string;
      version: string;
      digest: string;
    },
    actor: string,
    now: number,
  ) {
    await this.query(
      "INSERT INTO panda_force_portable_template_registry(id,revision) VALUES(1,1) ON DUPLICATE KEY UPDATE revision=revision+1",
    ).run();
    await this.query(
      "INSERT INTO panda_force_portable_template_audit(revision,action,id,version,digest,actor,createdAt) VALUES(?,?,?,?,?,?,?)",
    ).run(await this.revision(), action, value.id, value.version, value.digest, actor, now);
  }
}
