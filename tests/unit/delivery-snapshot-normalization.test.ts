import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDeliverySnapshot } from "../../src/server/delivery/storage/normalize-snapshot.js";
import { initializePublicationSchema } from "../../src/server/delivery/storage/schema.js";
import { PUBLICATION_SNAPSHOT_CHUNK_BYTES } from "../../src/server/delivery/storage/snapshot-chunks.js";

test("delivery import frames preserve large UTF-8 bytes, original references and immutable resume identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-frame-")),
    path = join(root, "publication.sqlite");
  try {
    const db = new Database(path, { create: true });
    initializePublicationSchema(db);
    const payload = JSON.stringify({ frozen: "多語🙂".repeat(180000) }),
      bytes = Buffer.from(payload),
      digest = createHash("sha256").update(bytes).digest("hex");
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    db.query("INSERT INTO publication_snapshots(hash,payload,bytes) VALUES(?,?,?)").run(digest, payload, bytes.length);
    db.query(
      "INSERT INTO publication_plans(id,ownerId,spaceId,connectionId,record,request,artifactHash) VALUES('plan','owner','space','connection','{}','{}',?)",
    ).run(digest);
    db.close();
    const before = await readFile(path),
      frame = await prepareDeliverySnapshot({ snapshotPath: path, directory: join(root, "frames") });
    expect(await readFile(path)).toEqual(before);
    const normalized = new Database(frame.snapshotPath, { readonly: true });
    try {
      expect(normalized.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const metadata = normalized
        .query<{ hash: string; payloadHash: string; bytes: number; chunkCount: number }, []>(
          "SELECT * FROM publication_snapshots",
        )
        .get()!;
      expect(metadata).toEqual({
        hash: digest,
        payloadHash: digest,
        bytes: bytes.length,
        chunkCount: Math.ceil(bytes.length / PUBLICATION_SNAPSHOT_CHUNK_BYTES),
      });
      const chunks = normalized
        .query<{ ordinal: number; bytes: number; digest: string; payload: Uint8Array }, []>(
          "SELECT ordinal,bytes,digest,payload FROM publication_snapshot_chunks ORDER BY ordinal",
        )
        .all();
      for (const [ordinal, chunk] of chunks.entries()) {
        expect(chunk.ordinal).toBe(ordinal);
        expect(chunk.bytes).toBe(chunk.payload.length);
        expect(chunk.bytes).toBeLessThanOrEqual(PUBLICATION_SNAPSHOT_CHUNK_BYTES);
        expect(createHash("sha256").update(chunk.payload).digest("hex")).toBe(chunk.digest);
      }
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.payload)))).toEqual(bytes);
    } finally {
      normalized.close();
    }
    const frameBytes = await readFile(frame.snapshotPath);
    expect(await prepareDeliverySnapshot({ snapshotPath: path, directory: join(root, "frames") })).toEqual(frame);
    expect(await readFile(frame.snapshotPath)).toEqual(frameBytes);
    const corrupt = new Database(frame.snapshotPath);
    corrupt.query("UPDATE publication_snapshot_chunks SET digest=? WHERE ordinal=1").run("0".repeat(64));
    corrupt.close();
    await expect(prepareDeliverySnapshot({ snapshotPath: path, directory: join(root, "frames") })).rejects.toThrow(
      "deliveryNormalizationChanged",
    );
    const changed = new Database(path);
    changed.query("UPDATE publication_snapshots SET bytes=bytes+1").run();
    changed.close();
    await expect(prepareDeliverySnapshot({ snapshotPath: path, directory: join(root, "frames") })).rejects.toThrow(
      "invalidPublicationSnapshotPayload",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
