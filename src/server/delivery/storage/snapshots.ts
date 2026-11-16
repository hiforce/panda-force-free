import type { Database } from "bun:sqlite";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";

/** Stores immutable payload bytes; the owning plan facade decodes and validates their content type. */
export class PublicationSnapshots {
  constructor(private db: Database) {}

  /** Called inside plan creation so quota accounting, insertion and the reference commit together. */
  put(payload: string) {
    const hash = digest(payload),
      bytes = Buffer.byteLength(payload);
    if (!this.db.query("SELECT hash FROM publication_snapshots WHERE hash=?").get(hash)) {
      const total = this.db
        .query<{ bytes: number }, []>("SELECT coalesce(sum(bytes),0) AS bytes FROM publication_snapshots")
        .get()!.bytes;
      if (total + bytes > 256 * 1024 * 1024) throw new DeliveryError("snapshotQuota", 507);
      this.db.query("INSERT INTO publication_snapshots VALUES(?,?,?)").run(hash, payload, bytes);
    }
    return hash;
  }

  get(hash: string | null) {
    const row =
      hash &&
      this.db.query<{ payload: string }, [string]>("SELECT payload FROM publication_snapshots WHERE hash=?").get(hash);
    if (!row || digest(row.payload) !== hash) throw new DeliveryError("snapshotUnavailable", 409);
    return row.payload;
  }

  /** Called inside the owning job transition transaction, never on an uncertain remote outcome. */
  release(id: string) {
    this.db.query("UPDATE publication_plans SET artifactHash=NULL WHERE id=?").run(id);
    this.db.exec(
      "DELETE FROM publication_snapshots WHERE hash NOT IN (SELECT artifactHash FROM publication_plans WHERE artifactHash IS NOT NULL)",
    );
  }
}
