import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
import { stageId } from "../../../shared/packages/stages/input.js";
import type { OwnedSourceReference } from "../../../shared/packages/ownership.js";
import { versionNamespace } from "./namespace.js";
import { VersionRecords, type VersionRow, type VersionOperationRow } from "./records.js";
import type {
  ImmutableVersions,
  VersionDescriptor,
  VersionPolicy,
  VersionErrorCode,
  VersionNamespace,
} from "./contracts.js";
const select =
  "SELECT v.*,CASE WHEN h.version=v.version THEN 1 ELSE 0 END AS active FROM native_theme_versions v LEFT JOIN native_theme_heads h ON h.actor=v.actor AND h.id=v.id";
/** One transaction owns immutable versions, actor CAS, command receipts and lifecycle changes; bodies remain in owned files. */
export class MySQLImmutableVersions<D, R> extends MySQLLedger implements AsyncStore<ImmutableVersions<D, R>> {
  private prefix: string;
  private statement<T = Record<string, unknown>, P extends unknown[] = unknown[]>(statement: string) {
    return super.query<T, P>(statement.replaceAll("native_theme_", this.prefix + "_"));
  }
  private records: VersionRecords<D, R>;
  constructor(
    pool: SQL,
    namespace: VersionNamespace,
    private policy: VersionPolicy<D, R>,
    private error: (code: VersionErrorCode) => Error,
    private now = Date.now,
  ) {
    super(pool, "panda_force_" + versionNamespace(namespace) + "_guard", [
      "revision",
      "expectedRevision",
      "enabled",
      "active",
      "installedAt",
      "cleaned",
      "createdAt",
      "count",
      "bytes",
    ]);
    this.prefix = "panda_force_" + versionNamespace(namespace);
    this.records = new VersionRecords(policy, error);
  }
  private async revision(actor: string) {
    return (
      (
        await this.statement<
          {
            revision: number;
          },
          [string]
        >("SELECT revision FROM native_theme_owners WHERE actor=?").get(actor)
      )?.revision ?? 0
    );
  }
  private async check(actor: string, revision: number) {
    if ((await this.revision(actor)) !== revision) throw this.error("conflict");
  }
  private async row(actor: string, id: string, version: string) {
    const row = await this.statement<VersionRow, [string, string, string]>(
      select + " WHERE v.actor=? AND v.id=? AND v.version=?",
    ).get(actor, id, version);
    if (!row) throw this.error("notFound");
    return row;
  }
  async snapshot(actor: string) {
    return this.readSnapshot(async () => {
      return {
        revision: await this.revision(actor),
        versions: (
          await this.statement<VersionRow, [string]>(select + " WHERE v.actor=? ORDER BY v.id,v.version").all(actor)
        ).map((row) => this.records.installed(row)),
      };
    });
  }
  async detail(actor: string, id: string, version: string) {
    return this.readSnapshot(async () => {
      return this.records.installed(await this.row(actor, id, version));
    });
  }
  async source(actor: string, id: string, version: string) {
    return this.readSnapshot(async () => {
      const row = await this.row(actor, id, version),
        data = this.records.installed(row);
      return { id: row.sourceId, digest: this.policy.identity(data.descriptor).sourceDigest };
    });
  }
  private async operationRow(actor: string, id: string) {
    return await this.statement<VersionOperationRow, [string, string]>(
      "SELECT * FROM native_theme_operations WHERE actor=? AND operationId=?",
    ).get(actor, id);
  }
  async operation(actor: string, id: string) {
    return this.readSnapshot(async () => {
      const row = await this.operationRow(actor, id);
      return row ? this.records.intent(row) : null;
    });
  }
  async reserve(
    actor: string,
    signature: string,
    value: VersionDescriptor<D>,
    approval: {
      operationId: string;
      expectedRevision: number;
    },
    settingsDigest: string,
  ) {
    return this.transaction(async () => {
      if (!this.policy.trusted(value)) throw this.error("invalidInput");
      const previous = await this.operationRow(actor, approval.operationId);
      if (previous) {
        if (previous.signature !== signature) throw this.error("conflict");
        return this.records.intent(previous);
      }
      await this.check(actor, approval.expectedRevision);
      const { id, version } = this.policy.identity(value.data),
        prior = await this.statement<
          {
            digest: string;
          },
          [string, string, string]
        >("SELECT digest FROM native_theme_versions WHERE actor=? AND id=? AND version=?").get(actor, id, version);
      if (prior && prior.digest !== value.digest) throw this.error("immutableVersion");
      const count = (await this.statement<
        {
          count: number;
          bytes: number;
        },
        []
      >(
        "SELECT count(*) AS count,COALESCE(sum(OCTET_LENGTH(descriptor)),0) AS bytes FROM native_theme_operations",
      ).get())!;
      if (count.count >= 4096 || count.bytes + Buffer.byteLength(JSON.stringify(value.data)) > 64 * 1024 * 1024)
        throw this.error("storageFull");
      await this.statement("INSERT INTO native_theme_operations VALUES(?,?,?,'pending',?,?,?,?,NULL,0,?)").run(
        actor,
        approval.operationId,
        signature,
        approval.expectedRevision,
        JSON.stringify(value.data),
        value.digest,
        settingsDigest,
        this.now(),
      );
      if (prior) await this.commitInside(actor, approval.operationId, await this.source(actor, id, version));
      return this.records.intent((await this.operationRow(actor, approval.operationId))!);
    });
  }
  private async commitInside(actor: string, id: string, source: OwnedSourceReference): Promise<R> {
    const operation = await this.operationRow(actor, id);
    if (!operation) throw this.error("notFound");
    if (operation.state === "committed") return JSON.parse(operation.receipt!) as R;
    if (operation.state !== "pending" || !operation.descriptor) throw this.error("conflict");
    await this.check(actor, operation.expectedRevision);
    const descriptor = this.records.metadata(operation.descriptor, operation.digest),
      identity = this.policy.identity(descriptor);
    if (source.digest !== identity.sourceDigest) throw this.error("conflict");
    stageId(source.id);
    const prior = await this.statement<
      {
        digest: string;
      },
      [string, string, string]
    >("SELECT digest FROM native_theme_versions WHERE actor=? AND id=? AND version=?").get(
      actor,
      identity.id,
      identity.version,
    );
    if (prior && prior.digest !== operation.digest) throw this.error("immutableVersion");
    if (!prior) {
      const sizes = (await this.statement<
        {
          count: number;
          bytes: number;
        },
        []
      >(
        "SELECT count(*) AS count,COALESCE(sum(OCTET_LENGTH(descriptor)),0) AS bytes FROM native_theme_versions",
      ).get())!;
      if (sizes.count >= 1024 || sizes.bytes + Buffer.byteLength(operation.descriptor) > 64 * 1024 * 1024)
        throw this.error("storageFull");
      await this.statement("INSERT INTO native_theme_versions VALUES(?,?,?,?,?,?,1,?)").run(
        actor,
        identity.id,
        identity.version,
        operation.digest,
        operation.descriptor,
        source.id,
        this.now(),
      );
      if (!(await this.statement("SELECT 1 FROM native_theme_heads WHERE actor=? AND id=?").get(actor, identity.id)))
        await this.statement("INSERT INTO native_theme_heads VALUES(?,?,?)").run(actor, identity.id, identity.version);
      await this.audit(actor, "install", identity.id, identity.version, operation.digest);
    }
    const receipt = this.policy.receipt({
      descriptor,
      operationId: id,
      revision: await this.revision(actor),
      digest: operation.digest,
      settingsDigest: operation.settingsDigest,
      status: prior ? "retained" : "installed",
    });
    await this.statement(
      "UPDATE native_theme_operations SET state='committed',descriptor=NULL,receipt=?,cleaned=1 WHERE actor=? AND operationId=?",
    ).run(JSON.stringify(receipt), actor, id);
    return receipt;
  }
  async commit(actor: string, id: string, source: OwnedSourceReference) {
    return this.transaction(async () => {
      return await this.commitInside(actor, id, source);
    });
  }
  async fail(actor: string, id: string) {
    return this.transaction(async () => {
      await this.statement(
        "UPDATE native_theme_operations SET state='failed',descriptor=NULL WHERE actor=? AND operationId=? AND state='pending'",
      ).run(actor, id);
    });
  }
  async cleanupDone(actor: string, id: string) {
    return this.transaction(async () => {
      await this.statement(
        "UPDATE native_theme_operations SET cleaned=1 WHERE actor=? AND operationId=? AND state='failed'",
      ).run(actor, id);
    });
  }
  async recoverable() {
    return this.readSnapshot(async () => {
      return await Promise.all(
        (
          await this.statement<VersionOperationRow, []>(
            "SELECT * FROM native_theme_operations WHERE state='pending' OR (state='failed' AND cleaned=0) ORDER BY createdAt LIMIT 32",
          ).all()
        ).map(async (row) => this.records.intent(row)),
      );
    });
  }
  async referenced(actor: string, sourceId: string) {
    return this.readSnapshot(async () => {
      return !!(await this.statement("SELECT 1 FROM native_theme_versions WHERE actor=? AND sourceId=?").get(
        actor,
        sourceId,
      ));
    });
  }
  async state(
    actor: string,
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    revision: number,
  ) {
    return this.transaction(async () => {
      if (!["enable", "disable", "activate"].includes(action)) throw this.error("invalidInput");
      await this.check(actor, revision);
      const value = await this.detail(actor, id, version);
      if (value.digest !== digest) throw this.error("immutableVersion");
      if (action === "activate") {
        if (!value.enabled) throw this.error("disabled");
        if (value.active) return value;
        await this.statement(
          "INSERT INTO native_theme_heads VALUES(?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version)",
        ).run(actor, id, version);
      } else {
        const enabled = action === "enable";
        if (value.enabled === enabled) return value;
        await this.statement("UPDATE native_theme_versions SET enabled=? WHERE actor=? AND id=? AND version=?").run(
          enabled ? 1 : 0,
          actor,
          id,
          version,
        );
        if (!enabled)
          await this.statement("DELETE FROM native_theme_heads WHERE actor=? AND id=? AND version=?").run(
            actor,
            id,
            version,
          );
      }
      await this.audit(actor, action, id, version, digest);
      return await this.detail(actor, id, version);
    });
  }
  private async audit(actor: string, action: string, id: string, version: string, digest: string) {
    await this.statement("INSERT INTO native_theme_owners VALUES(?,1) ON DUPLICATE KEY UPDATE revision=revision+1").run(
      actor,
    );
    await this.statement(
      "INSERT INTO native_theme_audit(actor,revision,action,id,version,digest,createdAt) VALUES(?,?,?,?,?,?,?)",
    ).run(actor, await this.revision(actor), action, id, version, digest, this.now());
  }
}
