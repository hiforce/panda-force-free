import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

export type MigrationValue = string | number | null | Uint8Array;
export interface MigrationTable {
  source: string;
  target: string;
  columns: readonly string[];
  sourceKeys: readonly string[];
  targetKeys: readonly string[];
  numericColumns?: readonly string[];
  optional?: boolean;
  project(row: Record<string, MigrationValue>): MigrationValue[];
}
export interface MigrationProgress {
  module: string;
  table: string;
  rows: number;
  stage: "copy" | "verify" | "complete";
}
export interface MigrationLimits {
  maxRecordBytes?: number;
  maxBatchBytes?: number;
}
/** Existing document and template JSON can be larger than the conservative default. */
export const largeContentMigrationLimits: MigrationLimits = {
  maxRecordBytes: 32 * 1024 * 1024,
  maxBatchBytes: 48 * 1024 * 1024,
};
const migrationLimits = (limits: MigrationLimits = {}) => {
  const maxRecordBytes = limits.maxRecordBytes ?? 1024 * 1024,
    maxBatchBytes = limits.maxBatchBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxRecordBytes) ||
    !Number.isSafeInteger(maxBatchBytes) ||
    maxRecordBytes < 1024 ||
    maxRecordBytes > 64 * 1024 * 1024 ||
    maxBatchBytes < maxRecordBytes ||
    maxBatchBytes > 128 * 1024 * 1024
  )
    throw new DataMigrationError("invalidMigrationLimits");
  return { maxRecordBytes, maxBatchBytes };
};
export class DataMigrationError extends Error {
  constructor(
    code: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(code);
  }
}
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
const signature = (values: readonly MigrationValue[]) =>
  JSON.stringify(values.map((v) => (v instanceof Uint8Array ? { binary: Buffer.from(v).toString("base64") } : v)));
const identifier = (value: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(value)) throw new DataMigrationError("invalidMigrationTable");
  return "`" + value + "`";
};

/** Copies a frozen module snapshot. The caller must fence application writers before capture and keep the target inactive until every module verifies. */
export async function migrateSQLiteModule(options: {
  sql: SQL;
  /** A coordinator may lend its lock-owning connection; this importer never releases a borrowed connection. */
  connection?: Awaited<ReturnType<SQL["reserve"]>>;
  snapshotPath: string;
  migrationId: string;
  module: string;
  converterVersion: number;
  tables: readonly MigrationTable[];
  limits?: MigrationLimits;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  const { sql: pool, snapshotPath, migrationId, module, tables, converterVersion } = options;
  const limits = migrationLimits(options.limits);
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(migrationId) ||
    !/^[a-z][a-z0-9-]{1,47}$/.test(module) ||
    !Number.isSafeInteger(converterVersion) ||
    converterVersion < 1
  )
    throw new DataMigrationError("invalidMigrationIdentity");
  const stat = await lstat(snapshotPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DataMigrationError("invalidMigrationSnapshot");
  for (const table of tables) {
    if (
      !table.target.startsWith("panda_force_") ||
      table.columns.length === 0 ||
      table.sourceKeys.length === 0 ||
      table.sourceKeys.length !== table.targetKeys.length
    )
      throw new DataMigrationError("invalidMigrationTable");
    for (const name of [table.source, table.target, ...table.columns, ...table.sourceKeys, ...table.targetKeys])
      identifier(name);
  }
  const mappingHash = createHash("sha256")
    .update(
      JSON.stringify({ converterVersion, tables: tables.map(({ project: _project, ...definition }) => definition) }),
    )
    .digest("hex");
  const sourceHash = await hashFile(snapshotPath),
    source = new Database(snapshotPath, { readonly: true, strict: true });
  const reserved =
    options.connection ??
    (await pool.reserve().catch((error) => {
      source.close();
      throw error;
    }));
  // Keep all import operations on the lock-owning connection. An otherwise idle
  // reserved connection can expire while a separate pool connection copies rows.
  const sql = reserved;
  let locked = false,
    failed = false;
  let failure: unknown,
    result: { module: string; migrationId: string; sourceHash: string; state: "complete" } | undefined;
  try {
    locked =
      Number(
        (await reserved`SELECT GET_LOCK(CONCAT('pf-data:',LEFT(SHA2(DATABASE(),256),40)),0) acquired`)[0].acquired,
      ) === 1;
    if (!locked) throw new DataMigrationError("dataMigrationBusy");
    const maxAllowedPacket = Number((await sql`SELECT @@max_allowed_packet packet`)[0].packet),
      batchBudget = Math.min(limits.maxBatchBytes, maxAllowedPacket - 65536);
    if (!Number.isSafeInteger(maxAllowedPacket) || batchBudget < 1024)
      throw new DataMigrationError("migrationPacketLimitTooSmall");
    await sql.begin(async (tx) => {
      const previous =
        await tx`SELECT id,sourceHash,mappingHash FROM panda_force_data_migration_runs WHERE module=${module} FOR UPDATE`;
      if (previous.length) {
        if (previous[0].id !== migrationId || previous[0].sourceHash !== sourceHash)
          throw new DataMigrationError("migrationSourceChanged");
        if (previous[0].mappingHash !== mappingHash) throw new DataMigrationError("migrationMappingChanged");
        await tx`UPDATE panda_force_data_migration_runs SET state='copying',updatedAt=${Date.now()} WHERE id=${migrationId} AND module=${module}`;
        return;
      }
      for (const table of tables)
        if (Number((await tx.unsafe(`SELECT COUNT(*) n FROM ${identifier(table.target)}`))[0].n) !== 0)
          throw new DataMigrationError("migrationTargetNotEmpty");
      await tx`INSERT INTO panda_force_data_migration_runs(id,module,sourceHash,mappingHash,state,createdAt,updatedAt) VALUES(${migrationId},${module},${sourceHash},${mappingHash},'copying',${Date.now()},${Date.now()})`;
    });
    for (const table of tables) {
      const exists = !!source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.source);
      if (!exists && !table.optional) throw new DataMigrationError("migrationSourceTableMissing");
      const previous = (
        await sql`SELECT cursorValue,rowsCopied FROM panda_force_data_migration_tables WHERE migrationId=${migrationId} AND module=${module} AND tableName=${table.target}`
      )[0];
      let cursor = Number(previous?.cursorValue ?? 0),
        copied = Number(previous?.rowsCopied ?? 0);
      while (exists) {
        const batch: MigrationValue[][] = [];
        let bytes = 0,
          last = cursor;
        // Iterate rather than materializing one hundred potentially large bodies.
        const candidates = source.prepare<Record<string, MigrationValue>, [number]>(
          `SELECT rowid AS __cursor,* FROM ${identifier(table.source)} WHERE rowid>? ORDER BY rowid LIMIT 100`,
        );
        try {
          for (const row of candidates.iterate(cursor)) {
            const values = table.project(row);
            if (
              values.length !== table.columns.length ||
              values.some(
                (v) =>
                  v !== null &&
                  !(v instanceof Uint8Array) &&
                  typeof v !== "string" &&
                  (typeof v !== "number" || !Number.isSafeInteger(v)),
              )
            )
              throw new DataMigrationError("invalidMigrationRecord");
            const recordBytes = Buffer.byteLength(signature(values)),
              size = recordBytes + values.length * 16 + 128;
            if (recordBytes > limits.maxRecordBytes)
              throw new DataMigrationError("migrationRecordTooLarge", { module, table: table.target, recordBytes });
            if (size > batchBudget)
              throw new DataMigrationError("migrationPacketLimitTooSmall", {
                module,
                table: table.target,
                requiredBytes: size + 65536,
                maxAllowedPacket,
              });
            if (batch.length && bytes + size > batchBudget) break;
            batch.push(values.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value)));
            bytes += size;
            last = Number(row.__cursor);
          }
        } finally {
          candidates.finalize();
        }
        if (!batch.length) break;
        await sql.begin(async (tx) => {
          const placeholders = batch.map((row) => "(" + row.map(() => "?").join(",") + ")").join(",");
          await tx.unsafe(
            `INSERT INTO ${identifier(table.target)}(${table.columns.map(identifier).join(",")}) VALUES ${placeholders}`,
            batch.flat(),
          );
          await tx`INSERT INTO panda_force_data_migration_tables(migrationId,module,tableName,cursorValue,rowsCopied,checksum,state,updatedAt) VALUES(${migrationId},${module},${table.target},${last},${copied + batch.length},NULL,'copying',${Date.now()}) ON DUPLICATE KEY UPDATE cursorValue=VALUES(cursorValue),rowsCopied=VALUES(rowsCopied),checksum=NULL,state='copying',updatedAt=VALUES(updatedAt)`;
        });
        cursor = last;
        copied += batch.length;
        await options.progress?.({ module, table: table.target, rows: copied, stage: "copy" });
      }
      const sourceDigest = createHash("sha256");
      let sourceCount = 0;
      if (exists)
        for (const row of source
          .query<Record<string, MigrationValue>, []>(
            `SELECT rowid AS __cursor,* FROM ${identifier(table.source)} ORDER BY ${table.sourceKeys.map(identifier).join(",")}`,
          )
          .iterate()) {
          sourceDigest.update(signature(table.project(row)) + "\n");
          sourceCount++;
        }
      const targetDigest = createHash("sha256");
      let targetCount = 0,
        lastKey: MigrationValue[] = [];
      for (;;) {
        const keySql = lastKey.length
          ? `WHERE (${table.targetKeys.map(identifier).join(",")}) > (${lastKey.map(() => "?").join(",")})`
          : "";
        // Read only keys and lengths before loading payloads, so verification is
        // bounded by bytes as well as row count for both text and binary bodies.
        const sizeExpression = table.columns
          .map((column) => `COALESCE(OCTET_LENGTH(${identifier(column)}),0)`)
          .join("+");
        const candidates = await sql.unsafe(
          `SELECT ${table.targetKeys.map(identifier).join(",")},(${sizeExpression}+${table.columns.length * 32 + 128}) AS __migrationBytes FROM ${identifier(table.target)} ${keySql} ORDER BY ${table.targetKeys.map(identifier).join(",")} LIMIT 100`,
          lastKey,
        );
        if (!candidates.length) break;
        let budget = 0,
          count = 0;
        for (const row of candidates) {
          const bytes = Number(row.__migrationBytes);
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > batchBudget)
            throw new DataMigrationError("migrationRecordTooLarge", { module, table: table.target });
          if (count && budget + bytes > batchBudget) break;
          budget += bytes;
          count++;
        }
        const upperKey = table.targetKeys.map((c) => candidates[count - 1][c]),
          upperSql = `(${table.targetKeys.map(identifier).join(",")}) <= (${upperKey.map(() => "?").join(",")})`,
          rows = await sql.unsafe(
            `SELECT ${table.columns.map(identifier).join(",")} FROM ${identifier(table.target)} ${keySql ? keySql + " AND " : "WHERE "}${upperSql} ORDER BY ${table.targetKeys.map(identifier).join(",")} LIMIT ${count}`,
            [...lastKey, ...upperKey],
          );
        if (!rows.length) throw new DataMigrationError("migrationVerificationFailed");
        for (const row of rows) {
          targetDigest.update(
            signature(
              table.columns.map((c) => {
                const value = row[c];
                if (value === null || !table.numericColumns?.includes(c)) return value;
                const numeric = Number(value);
                if (!Number.isSafeInteger(numeric)) throw new DataMigrationError("migrationNumericOverflow");
                return numeric;
              }),
            ) + "\n",
          );
          targetCount++;
        }
        lastKey = table.targetKeys.map((c) => rows[rows.length - 1][c]);
      }
      const checksum = sourceDigest.digest("hex");
      const targetChecksum = targetDigest.digest("hex");
      if (sourceCount !== targetCount || checksum !== targetChecksum)
        throw new DataMigrationError("migrationVerificationFailed", {
          module,
          table: table.target,
          sourceCount,
          targetCount,
          sourceChecksum: checksum,
          targetChecksum,
        });
      // Deleted high identifiers still reserve their sequence positions. Restoring
      // MAX(id) alone could reuse an externally referenced, previously deleted id.
      if (exists && source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
        const sequence = source
          .query<{ seq: number }, [string]>("SELECT seq FROM sqlite_sequence WHERE name=?")
          .get(table.source);
        if (sequence) {
          const next = sequence.seq + 1;
          if (!Number.isSafeInteger(next) || next < 1) throw new DataMigrationError("migrationNumericOverflow");
          const counter =
            await sql`SELECT 1 present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table.target} AND EXTRA='auto_increment'`;
          if (counter.length) {
            // INFORMATION_SCHEMA.TABLES caches statistics, including the old
            // counter, across ALTER. SHOW CREATE reads the current definition.
            const nextIdentifier = async () => {
              const definition = String(
                (await sql.unsafe(`SHOW CREATE TABLE ${identifier(table.target)}`))[0]?.["Create Table"] ?? "",
              );
              if (!definition) throw new DataMigrationError("migrationVerificationFailed");
              return Number(/\bAUTO_INCREMENT=(\d+)\b/.exec(definition)?.[1] ?? 1);
            };
            const current = await nextIdentifier();
            if (!Number.isSafeInteger(current) || current < 1) throw new DataMigrationError("migrationNumericOverflow");
            if (current < next) await sql.unsafe(`ALTER TABLE ${identifier(table.target)} AUTO_INCREMENT = ${next}`);
            const restored = await nextIdentifier();
            if (!Number.isSafeInteger(restored) || restored < next)
              throw new DataMigrationError("migrationVerificationFailed");
          }
        }
      }
      await sql`INSERT INTO panda_force_data_migration_tables(migrationId,module,tableName,cursorValue,rowsCopied,checksum,state,updatedAt) VALUES(${migrationId},${module},${table.target},${cursor},${sourceCount},${checksum},'complete',${Date.now()}) ON DUPLICATE KEY UPDATE checksum=VALUES(checksum),state='complete',updatedAt=VALUES(updatedAt)`;
      await options.progress?.({ module, table: table.target, rows: sourceCount, stage: "verify" });
    }
    if ((await hashFile(snapshotPath)) !== sourceHash) throw new DataMigrationError("migrationSourceChanged");
    await sql`UPDATE panda_force_data_migration_runs SET state='complete',updatedAt=${Date.now()} WHERE id=${migrationId} AND module=${module}`;
    await options.progress?.({ module, table: "", rows: 0, stage: "complete" });
    result = { module, migrationId, sourceHash, state: "complete" };
  } catch (error) {
    failed = true;
    failure = error;
    try {
      await sql`UPDATE panda_force_data_migration_runs SET state='failed',updatedAt=${Date.now()} WHERE id=${migrationId} AND module=${module} AND sourceHash=${sourceHash} AND mappingHash=${mappingHash}`;
    } catch {}
  } finally {
    try {
      if (locked) await reserved`SELECT RELEASE_LOCK(CONCAT('pf-data:',LEFT(SHA2(DATABASE(),256),40)))`;
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      if (!options.connection) reserved.release();
      source.close();
    }
  }
  if (failed) throw failure;
  return result!;
}
