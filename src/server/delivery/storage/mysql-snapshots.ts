import { createHash } from "node:crypto";
import { mysqlInteger } from "../../database/mysql-model.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import {
  PUBLICATION_SNAPSHOT_CHUNK_BYTES as chunkBytes,
  PUBLICATION_SNAPSHOT_MAX_BYTES as quota,
} from "./snapshot-chunks.js";
/** Existing full-artifact callers retain their immutable payload API; relational chunks bound individual SQL packets. */
export class MySQLPublicationSnapshots {
  constructor(private db: MySQLSession) {}
  async put(payload: string) {
    return this.db.atomic(async () => {
      const hash = digest(payload),
        bytes = Buffer.from(payload, "utf8");
      if (await this.db.one("SELECT hash FROM panda_force_publication_snapshots WHERE hash=?", [hash])) return hash;
      const used = await this.db.one<{
        bytes: number;
      }>("SELECT COALESCE(SUM(bytes),0) bytes FROM panda_force_publication_snapshots");
      if (bytes.length > quota || used!.bytes + bytes.length > quota) throw new DeliveryError("snapshotQuota", 507);
      const count = Math.ceil(bytes.length / chunkBytes);
      await this.db.execute(
        "INSERT INTO panda_force_publication_snapshots(hash,payloadHash,bytes,chunkCount) VALUES(?,?,?,?)",
        [hash, hash, bytes.length, count],
      );
      for (let start = 0; start < count; start += 16) {
        const values: unknown[] = [];
        let placeholders: string[] = [];
        for (let ordinal = start; ordinal < Math.min(start + 16, count); ordinal++) {
          const part = bytes.subarray(ordinal * chunkBytes, Math.min((ordinal + 1) * chunkBytes, bytes.length));
          values.push(hash, ordinal, part.length, digest(part), part);
          placeholders.push("(?,?,?,?,?)");
        }
        await this.db.execute(
          "INSERT INTO panda_force_publication_snapshot_chunks(snapshotId,ordinal,bytes,digest,payload) VALUES" +
            placeholders.join(","),
          values,
        );
      }
      return hash;
    });
  }
  async get(hash: string | null) {
    return this.db.atomic(async () => {
      const row =
        hash &&
        (await this.db.one<{
          hash: string;
          payloadHash: string;
          bytes: number;
          chunkCount: number;
        }>("SELECT hash,payloadHash,bytes,chunkCount FROM panda_force_publication_snapshots WHERE hash=?", [hash]));
      if (
        !row ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        row.bytes > quota ||
        row.chunkCount !== Math.ceil(row.bytes / chunkBytes) ||
        row.payloadHash !== row.hash
      )
        throw new DeliveryError("snapshotUnavailable", 409);
      const parts: Buffer[] = [],
        sum = createHash("sha256");
      let ordinal = 0,
        total = 0;
      while (ordinal < row.chunkCount) {
        const page = await this.db.all<{
          ordinal: number;
          bytes: number;
          digest: string;
          payload: Uint8Array;
        }>(
          "SELECT ordinal,bytes,digest,payload FROM panda_force_publication_snapshot_chunks WHERE snapshotId=? AND ordinal>=? ORDER BY ordinal LIMIT 16",
          [hash, ordinal],
        );
        if (!page.length) throw new DeliveryError("snapshotUnavailable", 409);
        for (const part of page) {
          const position = mysqlInteger(part.ordinal),
            bytes = Buffer.from(part.payload);
          if (
            position !== ordinal ||
            position >= row.chunkCount ||
            bytes.length !== mysqlInteger(part.bytes) ||
            bytes.length !== Math.min(chunkBytes, row.bytes - total) ||
            digest(bytes) !== part.digest
          )
            throw new DeliveryError("snapshotUnavailable", 409);
          total += bytes.length;
          ordinal++;
          sum.update(bytes);
          parts.push(bytes);
        }
      }
      const extra = await this.db.one(
        "SELECT 1 FROM panda_force_publication_snapshot_chunks WHERE snapshotId=? AND ordinal>=? LIMIT 1",
        [hash, row.chunkCount],
      );
      if (extra || total !== row.bytes || sum.digest("hex") !== row.payloadHash)
        throw new DeliveryError("snapshotUnavailable", 409);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, total));
      } catch {
        throw new DeliveryError("snapshotUnavailable", 409);
      }
    });
  }
  async release(id: string) {
    return this.db.atomic(async () => {
      await this.db.execute("UPDATE panda_force_publication_plans SET artifactHash=NULL WHERE id=?", [id]);
      await this.db.execute(
        "DELETE c FROM panda_force_publication_snapshot_chunks c LEFT JOIN panda_force_publication_plans p ON p.artifactHash=c.snapshotId WHERE p.id IS NULL",
      );
      await this.db.execute(
        "DELETE s FROM panda_force_publication_snapshots s LEFT JOIN panda_force_publication_plans p ON p.artifactHash=s.hash WHERE p.id IS NULL",
      );
    });
  }
}
