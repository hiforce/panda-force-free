import type { Database, SQLQueryBindings } from "bun:sqlite";
import { stageId } from "../../../shared/packages/stages/input.js";
import type { OwnedSourceReference } from "../../../shared/packages/ownership.js";
import { versionNamespace } from "./database.js";
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
export class SqliteImmutableVersions<D, R> implements ImmutableVersions<D, R> {
  private prefix: string;
  private records: VersionRecords<D, R>;
  constructor(
    private db: Database,
    namespace: VersionNamespace,
    private policy: VersionPolicy<D, R>,
    private error: (code: VersionErrorCode) => Error,
    private now = Date.now,
  ) {
    this.prefix = versionNamespace(namespace);
    this.records = new VersionRecords(policy, error);
  }
  private query<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string) {
    return this.db.query<T, P>(sql.replaceAll("native_theme_", this.prefix + "_"));
  }
  private revision(actor: string) {
    return (
      this.query<{ revision: number }, [string]>("SELECT revision FROM native_theme_owners WHERE actor=?").get(actor)
        ?.revision ?? 0
    );
  }
  private check(actor: string, revision: number) {
    if (this.revision(actor) !== revision) throw this.error("conflict");
  }
  private row(actor: string, id: string, version: string) {
    const row = this.query<VersionRow, [string, string, string]>(
      select + " WHERE v.actor=? AND v.id=? AND v.version=?",
    ).get(actor, id, version);
    if (!row) throw this.error("notFound");
    return row;
  }
  snapshot(actor: string) {
    return {
      revision: this.revision(actor),
      versions: this.query<VersionRow, [string]>(select + " WHERE v.actor=? ORDER BY v.id,v.version")
        .all(actor)
        .map((row) => this.records.installed(row)),
    };
  }
  detail(actor: string, id: string, version: string) {
    return this.records.installed(this.row(actor, id, version));
  }
  source(actor: string, id: string, version: string) {
    const row = this.row(actor, id, version),
      data = this.records.installed(row);
    return { id: row.sourceId, digest: this.policy.identity(data.descriptor).sourceDigest };
  }
  private operationRow(actor: string, id: string) {
    return this.query<VersionOperationRow, [string, string]>(
      "SELECT * FROM native_theme_operations WHERE actor=? AND operationId=?",
    ).get(actor, id);
  }
  operation(actor: string, id: string) {
    const row = this.operationRow(actor, id);
    return row ? this.records.intent(row) : null;
  }
  reserve(
    actor: string,
    signature: string,
    value: VersionDescriptor<D>,
    approval: { operationId: string; expectedRevision: number },
    settingsDigest: string,
  ) {
    if (!this.policy.trusted(value)) throw this.error("invalidInput");
    return this.db
      .transaction(() => {
        const previous = this.operationRow(actor, approval.operationId);
        if (previous) {
          if (previous.signature !== signature) throw this.error("conflict");
          return this.records.intent(previous);
        }
        this.check(actor, approval.expectedRevision);
        const { id, version } = this.policy.identity(value.data),
          prior = this.query<{ digest: string }, [string, string, string]>(
            "SELECT digest FROM native_theme_versions WHERE actor=? AND id=? AND version=?",
          ).get(actor, id, version);
        if (prior && prior.digest !== value.digest) throw this.error("immutableVersion");
        const count = this.query<{ count: number; bytes: number }, []>(
          "SELECT count(*) AS count,COALESCE(sum(length(CAST(descriptor AS BLOB))),0) AS bytes FROM native_theme_operations",
        ).get()!;
        if (count.count >= 4096 || count.bytes + Buffer.byteLength(JSON.stringify(value.data)) > 64 * 1024 * 1024)
          throw this.error("storageFull");
        this.query("INSERT INTO native_theme_operations VALUES(?,?,?,'pending',?,?,?,?,NULL,0,?)").run(
          actor,
          approval.operationId,
          signature,
          approval.expectedRevision,
          JSON.stringify(value.data),
          value.digest,
          settingsDigest,
          this.now(),
        );
        if (prior) this.commitInside(actor, approval.operationId, this.source(actor, id, version));
        return this.records.intent(this.operationRow(actor, approval.operationId)!);
      })
      .immediate();
  }
  private commitInside(actor: string, id: string, source: OwnedSourceReference): R {
    const operation = this.operationRow(actor, id);
    if (!operation) throw this.error("notFound");
    if (operation.state === "committed") return JSON.parse(operation.receipt!) as R;
    if (operation.state !== "pending" || !operation.descriptor) throw this.error("conflict");
    this.check(actor, operation.expectedRevision);
    const descriptor = this.records.metadata(operation.descriptor, operation.digest),
      identity = this.policy.identity(descriptor);
    if (source.digest !== identity.sourceDigest) throw this.error("conflict");
    stageId(source.id);
    const prior = this.query<{ digest: string }, [string, string, string]>(
      "SELECT digest FROM native_theme_versions WHERE actor=? AND id=? AND version=?",
    ).get(actor, identity.id, identity.version);
    if (prior && prior.digest !== operation.digest) throw this.error("immutableVersion");
    if (!prior) {
      const sizes = this.query<{ count: number; bytes: number }, []>(
        "SELECT count(*) AS count,COALESCE(sum(length(CAST(descriptor AS BLOB))),0) AS bytes FROM native_theme_versions",
      ).get()!;
      if (sizes.count >= 1024 || sizes.bytes + Buffer.byteLength(operation.descriptor) > 64 * 1024 * 1024)
        throw this.error("storageFull");
      this.query("INSERT INTO native_theme_versions VALUES(?,?,?,?,?,?,1,?)").run(
        actor,
        identity.id,
        identity.version,
        operation.digest,
        operation.descriptor,
        source.id,
        this.now(),
      );
      if (!this.query("SELECT 1 FROM native_theme_heads WHERE actor=? AND id=?").get(actor, identity.id))
        this.query("INSERT INTO native_theme_heads VALUES(?,?,?)").run(actor, identity.id, identity.version);
      this.audit(actor, "install", identity.id, identity.version, operation.digest);
    }
    const receipt = this.policy.receipt({
      descriptor,
      operationId: id,
      revision: this.revision(actor),
      digest: operation.digest,
      settingsDigest: operation.settingsDigest,
      status: prior ? "retained" : "installed",
    });
    this.query(
      "UPDATE native_theme_operations SET state='committed',descriptor=NULL,receipt=?,cleaned=1 WHERE actor=? AND operationId=?",
    ).run(JSON.stringify(receipt), actor, id);
    return receipt;
  }
  commit(actor: string, id: string, source: OwnedSourceReference) {
    return this.db.transaction(() => this.commitInside(actor, id, source)).immediate();
  }
  fail(actor: string, id: string) {
    this.query(
      "UPDATE native_theme_operations SET state='failed',descriptor=NULL WHERE actor=? AND operationId=? AND state='pending'",
    ).run(actor, id);
  }
  cleanupDone(actor: string, id: string) {
    this.query("UPDATE native_theme_operations SET cleaned=1 WHERE actor=? AND operationId=? AND state='failed'").run(
      actor,
      id,
    );
  }
  recoverable() {
    return this.query<VersionOperationRow, []>(
      "SELECT * FROM native_theme_operations WHERE state='pending' OR (state='failed' AND cleaned=0) ORDER BY createdAt LIMIT 32",
    )
      .all()
      .map((row) => this.records.intent(row));
  }
  referenced(actor: string, sourceId: string) {
    return !!this.query("SELECT 1 FROM native_theme_versions WHERE actor=? AND sourceId=?").get(actor, sourceId);
  }
  state(
    actor: string,
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    revision: number,
  ) {
    if (!["enable", "disable", "activate"].includes(action)) throw this.error("invalidInput");
    return this.db
      .transaction(() => {
        this.check(actor, revision);
        const value = this.detail(actor, id, version);
        if (value.digest !== digest) throw this.error("immutableVersion");
        if (action === "activate") {
          if (!value.enabled) throw this.error("disabled");
          if (value.active) return value;
          this.query(
            "INSERT INTO native_theme_heads VALUES(?,?,?) ON CONFLICT(actor,id) DO UPDATE SET version=excluded.version",
          ).run(actor, id, version);
        } else {
          const enabled = action === "enable";
          if (value.enabled === enabled) return value;
          this.query("UPDATE native_theme_versions SET enabled=? WHERE actor=? AND id=? AND version=?").run(
            enabled ? 1 : 0,
            actor,
            id,
            version,
          );
          if (!enabled)
            this.query("DELETE FROM native_theme_heads WHERE actor=? AND id=? AND version=?").run(actor, id, version);
        }
        this.audit(actor, action, id, version, digest);
        return this.detail(actor, id, version);
      })
      .immediate();
  }
  private audit(actor: string, action: string, id: string, version: string, digest: string) {
    this.query("INSERT INTO native_theme_owners VALUES(?,1) ON CONFLICT(actor) DO UPDATE SET revision=revision+1").run(
      actor,
    );
    this.query(
      "INSERT INTO native_theme_audit(actor,revision,action,id,version,digest,createdAt) VALUES(?,?,?,?,?,?,?)",
    ).run(actor, this.revision(actor), action, id, version, digest, this.now());
  }
}
