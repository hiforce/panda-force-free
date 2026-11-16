import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import { float32Vector } from "../providers/vector-rows.js";
import type { EmbeddingPolicy } from "./policy.js";
import { EMBEDDING_LEASE_MS } from "./budget.js";

interface Entry {
  key: string;
  namespace: string;
  token: string;
  state: string;
  dimensions: number;
  bytes: number;
  digest: string;
  accessedAt: number;
  expiresAt: number;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Files are published only after a durable metadata reservation and fsync; crash leftovers retain an exact cleanup owner. */
export class EmbeddingCache {
  constructor(
    private db: Database,
    private root: string,
    private policy: EmbeddingPolicy,
    private now = () => Date.now(),
    private leaseCurrent?: (namespace: string, token: string) => boolean | Promise<boolean>,
  ) {}
  private path(row: Pick<Entry, "key" | "token">) {
    if (!/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9-]{36}$/.test(row.token))
      throw new SearchError("unavailable", 503);
    return join(this.root, row.key + "-" + row.token + ".f32");
  }
  private row(key: string) {
    return this.db.query<Entry, [string]>("SELECT * FROM embedding_cache WHERE key=?").get(key);
  }
  private async remove(row: Entry) {
    const changed = this.db
      .query("UPDATE embedding_cache SET state='deleting' WHERE key=? AND token=?")
      .run(row.key, row.token).changes;
    if (!changed) return;
    await unlink(this.path(row)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new SearchError("unavailable", 503);
    });
    this.db.query("DELETE FROM embedding_cache WHERE key=? AND token=? AND state='deleting'").run(row.key, row.token);
  }
  async sweep() {
    const rows = this.db
      .query<Entry, [number]>(
        "SELECT * FROM embedding_cache WHERE state='deleting' OR expiresAt<=? ORDER BY expiresAt LIMIT 128",
      )
      .all(this.now());
    for (const row of rows) await this.remove(row);
  }
  async get(key: string, namespace: string, dimensions: number): Promise<number[] | null> {
    const row = this.row(key);
    if (!row) return null;
    if (
      row.state !== "ready" ||
      row.namespace !== namespace ||
      row.dimensions !== dimensions ||
      row.expiresAt <= this.now()
    ) {
      if (row.state === "ready" || row.expiresAt <= this.now()) await this.remove(row);
      return null;
    }
    const expected = 12 + dimensions * 4;
    let handle;
    try {
      handle = await open(this.path(row), constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await handle.stat()).size !== expected || row.bytes !== expected) throw new Error("corrupt");
      const buffer = Buffer.alloc(expected + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (
        bytes.length !== expected ||
        digest(bytes) !== row.digest ||
        bytes.subarray(0, 8).toString() !== "PFEMBED1" ||
        bytes.readUInt32LE(8) !== dimensions
      )
        throw new Error("corrupt");
      const vector = float32Vector(
        Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE(12 + i * 4)),
        dimensions,
      );
      this.db
        .query("UPDATE embedding_cache SET accessedAt=? WHERE key=? AND token=? AND state='ready'")
        .run(this.now(), key, row.token);
      return vector;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code &&
        !["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code!)
      )
        throw new SearchError("unavailable", 503);
      await this.remove(row);
      return null;
    } finally {
      await handle?.close();
    }
  }
  async put(
    key: string,
    namespace: string,
    lock: string,
    vector: number[],
    purpose: "document" | "query",
    signal: AbortSignal,
  ) {
    const values = float32Vector(vector, vector.length),
      bytes = Buffer.alloc(12 + vector.length * 4);
    bytes.write("PFEMBED1");
    bytes.writeUInt32LE(values.length, 8);
    values.forEach((v, i) => bytes.writeFloatLE(v, 12 + i * 4));
    await this.sweep();
    for (let attempt = 0; attempt < 128; attempt++) {
      if (this.leaseCurrent && !(await this.leaseCurrent(namespace, lock))) throw new SearchError("conflict", 409);
      const admitted = this.db
        .transaction(() => {
          if (
            !this.leaseCurrent &&
            !this.db
              .query("SELECT 1 FROM embedding_locks WHERE namespace=? AND token=? AND untilAt>?")
              .get(namespace, lock, this.now())
          )
            throw new SearchError("conflict", 409);
          const used = this.db
            .query<{ n: number; bytes: number }, []>("SELECT entries n,bytes FROM embedding_cache_totals WHERE id=1")
            .get()!;
          if (this.row(key) || used.n >= this.policy.cacheEntries || used.bytes + bytes.length > this.policy.cacheBytes)
            return null;
          const row = {
            key,
            namespace,
            token: randomUUID(),
            state: "writing",
            dimensions: vector.length,
            bytes: bytes.length,
            digest: digest(bytes),
            accessedAt: this.now(),
            expiresAt: this.now() + EMBEDDING_LEASE_MS,
          };
          this.db
            .query("INSERT INTO embedding_cache VALUES(?,?,?,?,?,?,?,?,?)")
            .run(
              row.key,
              row.namespace,
              row.token,
              row.state,
              row.dimensions,
              row.bytes,
              row.digest,
              row.accessedAt,
              row.expiresAt,
            );
          return row;
        })
        .immediate();
      if (!admitted) {
        const prior = this.row(key);
        if (prior) return false;
        const oldest = this.db
          .query<Entry, []>("SELECT * FROM embedding_cache WHERE state='ready' ORDER BY accessedAt,key LIMIT 1")
          .get();
        if (!oldest) return false;
        await this.remove(oldest);
        continue;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(
        this.path(admitted),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes, { signal });
        await handle.sync();
      } finally {
        await handle.close();
      }
      const ttl = purpose === "query" ? this.policy.queryTtlMinutes * 60000 : this.policy.documentTtlHours * 3600000;
      const held = !this.leaseCurrent || (await this.leaseCurrent(namespace, lock));
      const changed =
        held &&
        (this.leaseCurrent
          ? this.db
              .query("UPDATE embedding_cache SET state='ready',expiresAt=? WHERE key=? AND token=? AND state='writing'")
              .run(this.now() + ttl, key, admitted.token).changes
          : this.db
              .query(
                "UPDATE embedding_cache SET state='ready',expiresAt=? WHERE key=? AND token=? AND state='writing' AND EXISTS(SELECT 1 FROM embedding_locks WHERE namespace=? AND token=? AND untilAt>?)",
              )
              .run(this.now() + ttl, key, admitted.token, namespace, lock, this.now()).changes);
      if (changed !== 1) await unlink(this.path(admitted)).catch(() => {});
      return true;
    }
    return false;
  }
}
