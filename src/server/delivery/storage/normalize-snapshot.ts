import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  PUBLICATION_SNAPSHOT_CHUNK_BYTES as chunkBytes,
  PUBLICATION_SNAPSHOT_MAX_BYTES as quota,
} from "./snapshot-chunks.js";
export const DELIVERY_SNAPSHOT_CONVERTER_VERSION = 1;
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
const regular = async (path: string) => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
};
interface FrameMeta {
  sourceHash: string;
  converterVersion: number;
  chunkBytes: number;
  state: string;
}
function inspectFrame(path: string, sourceHash: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const meta = db
      .query<FrameMeta, []>(
        "SELECT sourceHash,converterVersion,chunkBytes,state FROM publication_delivery_normalization WHERE id=1",
      )
      .get();
    if (
      meta?.sourceHash !== sourceHash ||
      meta.converterVersion !== DELIVERY_SNAPSHOT_CONVERTER_VERSION ||
      meta.chunkBytes !== chunkBytes ||
      meta.state !== "complete"
    )
      throw Error("deliveryNormalizationChanged");
    if (db.query("PRAGMA foreign_key_check").get()) throw Error("invalidPublicationSnapshotReferences");
    let aggregate = 0;
    for (const row of db
      .query<{ hash: string; payloadHash: string; bytes: number; chunkCount: number }, []>(
        "SELECT hash,payloadHash,bytes,chunkCount FROM publication_snapshots ORDER BY hash",
      )
      .iterate()) {
      if (
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        (aggregate += row.bytes) > quota ||
        row.payloadHash !== row.hash ||
        row.chunkCount !== Math.ceil(row.bytes / chunkBytes)
      )
        throw Error("deliveryNormalizationChanged");
      const checksum = createHash("sha256");
      let ordinal = 0,
        total = 0;
      for (const chunk of db
        .query<{ ordinal: number; bytes: number; digest: string; payload: Uint8Array }, [string]>(
          "SELECT ordinal,bytes,digest,payload FROM publication_snapshot_chunks WHERE snapshotId=? ORDER BY ordinal",
        )
        .iterate(row.hash)) {
        if (
          chunk.ordinal !== ordinal++ ||
          chunk.bytes !== chunk.payload.length ||
          chunk.bytes !== Math.min(chunkBytes, row.bytes - total) ||
          createHash("sha256").update(chunk.payload).digest("hex") !== chunk.digest
        )
          throw Error("deliveryNormalizationChanged");
        total += chunk.bytes;
        checksum.update(chunk.payload);
      }
      if (ordinal !== row.chunkCount || total !== row.bytes || checksum.digest("hex") !== row.hash)
        throw Error("deliveryNormalizationChanged");
    }
  } finally {
    db.close();
  }
}
/** Prepare one durable, lossless import frame from an already-frozen source. A completed frame is reused verbatim for journal resume. */
export async function prepareDeliverySnapshot(options: { snapshotPath: string; directory: string }) {
  await regular(options.snapshotPath);
  const sourceHash = await hashFile(options.snapshotPath);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, `delivery-v${DELIVERY_SNAPSHOT_CONVERTER_VERSION}-${sourceHash}.sqlite`);
  try {
    await regular(path);
    inspectFrame(path, sourceHash);
    if ((await hashFile(options.snapshotPath)) !== sourceHash) throw Error("migrationSourceChanged");
    return { snapshotPath: path, sourceHash, converterVersion: DELIVERY_SNAPSHOT_CONVERTER_VERSION };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(options.directory, `.delivery-${randomUUID()}.sqlite`),
    file = await open(temporary, "wx", 0o600);
  await file.close();
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if (
      source.query<{ version: number }, []>("SELECT version FROM publication_delivery_schema WHERE id=1").get()
        ?.version !== 9
    )
      throw Error("unsupportedDeliverySnapshotVersion");
    if (source.query("PRAGMA foreign_key_check").get()) throw Error("invalidPublicationSnapshotReferences");
    source.query("VACUUM INTO ?").run(temporary);
  } finally {
    source.close();
  }
  const frame = new Database(temporary, { strict: true });
  try {
    frame.exec("PRAGMA foreign_keys=OFF;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;");
    frame
      .transaction(() => {
        frame.exec(`CREATE TABLE publication_snapshot_metadata(hash TEXT PRIMARY KEY,payloadHash TEXT NOT NULL,bytes INTEGER NOT NULL,chunkCount INTEGER NOT NULL);
    CREATE TABLE publication_snapshot_chunks(snapshotId TEXT NOT NULL,ordinal INTEGER NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(snapshotId,ordinal),FOREIGN KEY(snapshotId) REFERENCES publication_snapshots(hash));
    CREATE TABLE publication_delivery_normalization(id INTEGER PRIMARY KEY,sourceHash TEXT NOT NULL,converterVersion INTEGER NOT NULL,chunkBytes INTEGER NOT NULL,state TEXT NOT NULL);`);
        const payload = frame.query<{ payload: Uint8Array }, [number, number, string]>(
            "SELECT substr(CAST(payload AS BLOB),?,?) payload FROM publication_snapshots WHERE hash=?",
          ),
          insert = frame.query(
            "INSERT INTO publication_snapshot_chunks(snapshotId,ordinal,bytes,digest,payload) VALUES(?,?,?,?,?)",
          );
        let aggregate = 0;
        for (const row of frame
          .query<{ hash: string; bytes: number; payloadBytes: number }, []>(
            "SELECT hash,bytes,length(CAST(payload AS BLOB)) payloadBytes FROM publication_snapshots ORDER BY hash",
          )
          .iterate()) {
          if (
            !/^[a-f0-9]{64}$/.test(row.hash) ||
            !Number.isSafeInteger(row.bytes) ||
            row.bytes < 0 ||
            row.bytes !== row.payloadBytes ||
            (aggregate += row.bytes) > quota
          )
            throw Error("invalidPublicationSnapshotPayload");
          const checksum = createHash("sha256");
          let count = 0,
            total = 0;
          while (total < row.bytes) {
            const part = payload.get(total + 1, chunkBytes, row.hash)?.payload;
            if (!(part instanceof Uint8Array) || part.length !== Math.min(chunkBytes, row.bytes - total))
              throw Error("invalidPublicationSnapshotPayload");
            checksum.update(part);
            insert.run(row.hash, count, part.length, createHash("sha256").update(part).digest("hex"), part);
            count++;
            total += part.length;
          }
          const digest = checksum.digest("hex");
          if (digest !== row.hash) throw Error("invalidPublicationSnapshotPayload");
          frame
            .query("INSERT INTO publication_snapshot_metadata(hash,payloadHash,bytes,chunkCount) VALUES(?,?,?,?)")
            .run(row.hash, digest, total, count);
        }
        frame.exec(
          "DROP TABLE publication_snapshots;ALTER TABLE publication_snapshot_metadata RENAME TO publication_snapshots;",
        );
        frame
          .query(
            "INSERT INTO publication_delivery_normalization(id,sourceHash,converterVersion,chunkBytes,state) VALUES(1,?,?,?,'complete')",
          )
          .run(sourceHash, DELIVERY_SNAPSHOT_CONVERTER_VERSION, chunkBytes);
        if (frame.query("PRAGMA foreign_key_check").get()) throw Error("invalidPublicationSnapshotReferences");
      })
      .immediate();
    frame.exec("VACUUM");
  } finally {
    frame.close();
  }
  if ((await hashFile(options.snapshotPath)) !== sourceHash) throw Error("migrationSourceChanged");
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    inspectFrame(path, sourceHash);
  }
  const directory = await open(options.directory, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { snapshotPath: path, sourceHash, converterVersion: DELIVERY_SNAPSHOT_CONVERTER_VERSION };
}
