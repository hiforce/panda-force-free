import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { SkillRegistryStore, SkillRegistryCommand, SkillMutation } from "../ports.js";
import type {
  InstalledSkillPack,
  SkillCapture,
  SkillRegistryPage,
  SkillRegistryAudit,
} from "../../../shared/skills/registry.js";
import { freezeSkillValue } from "../../../shared/skills/resources.js";
import { SkillRegistryError } from "../errors.js";
import { installedSkillRecord, type SkillRegistryRow } from "./records.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import { consistentMySQLRead } from "../../database/consistent-read.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const select =
  "SELECT v.*,CASE WHEN h.version=v.version THEN 1 ELSE 0 END active FROM panda_force_skill_versions v LEFT JOIN panda_force_skill_heads h ON h.id=v.id";
type Row = Record<string, unknown>;
/** Registry revisions serialize mutations; immutable bundles remain in their existing content-addressed storage. */
export class MySQLSkillRegistry implements SkillRegistryStore {
  private readonly context = new AsyncLocalStorage<SQL>();
  constructor(private readonly pool: SQL) {}
  private get sql() {
    return this.context.getStore() ?? this.pool;
  }
  private async transaction<T>(write: boolean, work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    try {
      const transaction = async (tx: SQL) =>
        this.context.run(tx, async () => {
          if (write)
            await tx`INSERT INTO panda_force_skill_registry(id,revision) VALUES(1,0) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
          return work();
        });
      return await (write ? this.pool.begin(transaction) : consistentMySQLRead(this.pool, transaction));
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error;
      const failure = new SkillRegistryError("unavailable");
      failure.cause = error;
      throw failure;
    }
  }
  async revision() {
    const r = (await this.sql`SELECT revision FROM panda_force_skill_registry WHERE id=1`)[0];
    return r ? mysqlInteger(r.revision) : 0;
  }
  private async records(rows: Row[]): Promise<InstalledSkillPack[]> {
    if (!rows.length) return [];
    const exports = await this.sql.unsafe(
      "SELECT packageId,version,id,enabled FROM panda_force_skill_exports WHERE (packageId,version) IN (" +
        rows.map(() => "(?,?)").join(",") +
        ") ORDER BY id",
      rows.flatMap((r) => [r.id, r.version]),
    );
    return rows.map((r) =>
      installedSkillRecord(
        {
          ...r,
          installedAt: mysqlInteger(r.installedAt),
          active: mysqlInteger(r.active),
          removed: mysqlInteger(r.removed),
        } as SkillRegistryRow,
        exports
          .filter((e: Row) => e.packageId === r.id && e.version === r.version)
          .map((e: Row) => ({ id: String(e.id), enabled: mysqlInteger(e.enabled) !== 0 })),
      ),
    );
  }
  async get(id: string, version: string): Promise<InstalledSkillPack | null> {
    return this.transaction(
      false,
      async () =>
        (await this.records(await this.sql.unsafe(select + " WHERE v.id=? AND v.version=?", [id, version])))[0] ?? null,
    );
  }
  async detail(id: string, version: string) {
    return this.transaction(false, async () => ({
      revision: await this.revision(),
      package: await this.get(id, version),
    }));
  }
  async active(id: string) {
    return this.transaction(
      false,
      async () =>
        (
          await this.records(
            await this.sql.unsafe(select + " WHERE v.id=? AND h.version=v.version AND v.removed=0", [id]),
          )
        )[0] ?? null,
    );
  }
  async known(id: string) {
    return this.transaction(
      false,
      async () => !!(await this.sql`SELECT id FROM panda_force_skill_versions WHERE id=${id} LIMIT 1`).length,
    );
  }
  async list(cursor?: string, limit = 50, activeOnly = false): Promise<SkillRegistryPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SkillRegistryError("invalidInput");
    let id = "",
      version = "";
    if (cursor !== undefined) {
      try {
        if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        const tuple: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some((v) => typeof v !== "string")) throw Error();
        [id, version] = tuple as [string, string];
      } catch {
        throw new SkillRegistryError("invalidInput");
      }
    }
    return this.transaction(false, async () => {
      const rows: Row[] = await this.sql.unsafe(
          select +
            (activeOnly
              ? " WHERE h.version=v.version AND v.removed=0 AND EXISTS(SELECT 1 FROM panda_force_skill_exports e WHERE e.packageId=v.id AND e.version=v.version AND e.enabled=1) AND"
              : " WHERE") +
            " (v.id>? OR (v.id=? AND v.version>?)) ORDER BY v.id,v.version LIMIT ?",
          [id, id, version, limit + 1],
        ),
        visible = rows.slice(0, limit),
        last = visible.at(-1);
      return {
        revision: await this.revision(),
        packages: await this.records(visible),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(JSON.stringify([last.id, last.version])).toString("base64url")
            : null,
      };
    });
  }
  async audit(after?: number, limit = 100): Promise<SkillRegistryAudit[]> {
    if (
      (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new SkillRegistryError("invalidInput");
    return this.transaction(false, async () => {
      const rows = (
        await this.sql.unsafe(
          "SELECT * FROM panda_force_skill_audit WHERE sequence>? ORDER BY sequence " +
            (after === undefined ? "DESC" : "ASC") +
            " LIMIT ?",
          [after ?? 0, limit],
        )
      ).map(
        (r: Row) =>
          ({
            ...r,
            sequence: mysqlInteger(r.sequence),
            revision: mysqlInteger(r.revision),
            createdAt: mysqlInteger(r.createdAt),
            details: JSON.parse(String(r.details)),
          }) as SkillRegistryAudit,
      );
      return after === undefined ? rows.reverse() : rows;
    });
  }
  async replay(actor: string, id: string, request: string) {
    return this.transaction(false, async () => {
      const row = (
        await this.sql`SELECT actor,request,packageId,version FROM panda_force_skill_operations WHERE id=${id}`
      )[0];
      if (!row) return null;
      if (row.actor !== actor) throw new SkillRegistryError("notFound");
      if (row.request !== request) throw new SkillRegistryError("operationConflict");
      const value = await this.get(row.packageId, row.version);
      if (!value) throw new SkillRegistryError("unavailable");
      return value;
    });
  }
  private async exports(id: string, version: string, values: readonly { id: string; enabled: boolean }[]) {
    await this.sql`DELETE FROM panda_force_skill_exports WHERE packageId=${id} AND version=${version}`;
    for (const v of values)
      await this
        .sql`INSERT INTO panda_force_skill_exports(packageId,version,id,enabled) VALUES(${id},${version},${v.id},${v.enabled ? 1 : 0})`;
  }
  async apply(command: SkillRegistryCommand, mutation: SkillMutation): Promise<InstalledSkillPack> {
    return this.transaction(true, async () => {
      const replay = await this.replay(mutation.actor, mutation.id, mutation.request);
      if (replay) return replay;
      if ((await this.revision()) !== mutation.expectedRevision) throw new SkillRegistryError("registryConflict");
      if (Number((await this.sql`SELECT COUNT(*) n FROM panda_force_skill_operations`)[0].n) >= 100000)
        throw new SkillRegistryError("unavailable");
      const id = command.kind === "install" ? command.pack.id : command.id,
        version = command.kind === "install" ? command.pack.version : command.version,
        prior = await this.get(id, version);
      let details: unknown = {};
      if (command.kind === "install") {
        const v = command.pack;
        if (prior && prior.digest !== v.digest) throw new SkillRegistryError("immutableVersion");
        if (!prior) {
          const sizes = (
            await this
              .sql`SELECT COUNT(*) n,COALESCE(SUM(OCTET_LENGTH(manifest)),0) bytes FROM panda_force_skill_versions`
          )[0];
          if (
            Number(sizes.n) >= 1024 ||
            Number(sizes.bytes) + Buffer.byteLength(JSON.stringify(v.manifest)) > 64 * 1024 * 1024
          )
            throw new SkillRegistryError("unavailable");
          await this
            .sql`INSERT INTO panda_force_skill_versions(id,version,digest,manifest,origin,grants,installedAt,installedBy,removed) VALUES(${id},${version},${v.digest},${JSON.stringify(v.manifest)},${JSON.stringify(v.origin)},${JSON.stringify(v.grants)},${mutation.now},${mutation.actor},0)`;
        } else
          await this
            .sql`UPDATE panda_force_skill_versions SET origin=${JSON.stringify(v.origin)},grants=${JSON.stringify(v.grants)},removed=0 WHERE id=${id} AND version=${version}`;
        await this.exports(id, version, v.exports);
        await this
          .sql`INSERT INTO panda_force_skill_heads(id,version) VALUES(${id},${version}) ON DUPLICATE KEY UPDATE version=VALUES(version)`;
        details = { exports: v.exports, grants: v.grants, origin: v.origin };
      } else {
        if (!prior || prior.removed) throw new SkillRegistryError("notInstalled");
        if (command.kind === "activate") {
          if (!prior.exports.some((v) => v.enabled)) throw new SkillRegistryError("skillDisabled");
          await this
            .sql`INSERT INTO panda_force_skill_heads(id,version) VALUES(${id},${version}) ON DUPLICATE KEY UPDATE version=VALUES(version)`;
        } else if (command.kind === "exports") {
          const expected = prior.manifest.skills.map((v) => v.id).sort(),
            received = command.exports.map((v) => v.id).sort();
          if (expected.length !== received.length || expected.some((v, i) => v !== received[i]))
            throw new SkillRegistryError("invalidInput");
          await this.exports(id, version, command.exports);
          details = { exports: command.exports };
        } else {
          await this.sql`UPDATE panda_force_skill_versions SET removed=1 WHERE id=${id} AND version=${version}`;
          await this.sql`UPDATE panda_force_skill_exports SET enabled=0 WHERE packageId=${id} AND version=${version}`;
          await this.sql`DELETE FROM panda_force_skill_heads WHERE id=${id} AND version=${version}`;
        }
      }
      await this.sql`UPDATE panda_force_skill_registry SET revision=revision+1 WHERE id=1`;
      const revision = await this.revision(),
        value = await this.get(id, version);
      if (!value) throw new SkillRegistryError("unavailable");
      await this
        .sql`INSERT INTO panda_force_skill_operations(id,actor,request,packageId,version,revision) VALUES(${mutation.id},${mutation.actor},${mutation.request},${id},${version},${revision})`;
      await this
        .sql`INSERT INTO panda_force_skill_audit(revision,action,id,version,digest,actor,operationId,createdAt,details) VALUES(${revision},${command.kind},${id},${version},${value.digest},${mutation.actor},${mutation.id},${mutation.now},${JSON.stringify(details)})`;
      return value;
    });
  }
  captured(owner: string, id: string, request: string) {
    return this.readCapture(owner, id, request);
  }
  captureById(owner: string, id: string) {
    return this.readCapture(owner, id);
  }
  private readCapture(owner: string, id: string, request?: string): Promise<SkillCapture | null> {
    return this.transaction(false, async () => {
      const r = (await this.sql`SELECT owner,request,payload,digest FROM panda_force_skill_captures WHERE id=${id}`)[0];
      if (!r) return null;
      if (r.owner !== owner) throw new SkillRegistryError("notFound");
      if (request !== undefined && r.request !== request) throw new SkillRegistryError("operationConflict");
      if (hash(r.payload) !== r.digest) throw new SkillRegistryError("unavailable");
      const v = JSON.parse(r.payload) as SkillCapture;
      if (v.id !== id || v.owner !== owner || v.composition.schema !== 1) throw new SkillRegistryError("unavailable");
      return freezeSkillValue(v);
    });
  }
  async capture(value: SkillCapture, request: string, expectedRevision: number): Promise<SkillCapture> {
    return this.transaction(true, async () => {
      const prior = await this.captured(value.owner, value.id, request);
      if (prior) return prior;
      if ((await this.revision()) !== expectedRevision) throw new SkillRegistryError("registryConflict");
      const payload = JSON.stringify(value),
        bytes = Buffer.byteLength(payload),
        capacity = (
          await this.sql`SELECT COUNT(*) n,COALESCE(SUM(byteLength),0) bytes FROM panda_force_skill_captures`
        )[0];
      if (bytes > 1024 * 1024 || Number(capacity.n) >= 10000 || Number(capacity.bytes) + bytes > 128 * 1024 * 1024)
        throw new SkillRegistryError("unavailable");
      await this
        .sql`INSERT INTO panda_force_skill_captures(id,owner,request,payload,digest,byteLength,createdAt) VALUES(${value.id},${value.owner},${request},${payload},${hash(payload)},${bytes},${value.createdAt})`;
      return (await this.captured(value.owner, value.id, request))!;
    });
  }
}
