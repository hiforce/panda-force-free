import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IndexReference } from "../ports.js";
import { IndexIntegrityError } from "../integrity.js";
import { readIndexBytes, inspectSnapshot, snapshotDigest } from "./local-snapshot.js";
import { MAX_VECTOR_ROWS, vectorPageSize } from "./vector-rows.js";
interface VectorSeal {
  schema: 1;
  recipe: string;
  dimensions: number;
  rows: [string, string][];
}
export interface LoadedVectorSeal {
  rows: ReadonlyMap<string, string>;
  dimensions: number;
  pageSize: number;
}

/** Derived seals contain chunk identities and hashes, never text or vectors. Their root hash is in the durable ledger. */
export class VectorSealStore {
  private cache = new Map<string, { digest: string; stamp: string; bytes: number; value: LoadedVectorSeal }>();
  constructor(private readonly root: string) {}
  private path(name: string) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new IndexIntegrityError("corrupt");
    return join(this.root, name + ".json");
  }
  async put(
    name: string,
    recipe: string,
    dimensions: number,
    entries: [string, string][],
    signal: AbortSignal,
  ): Promise<IndexReference> {
    const path = this.path(name),
      value: VectorSeal = {
        schema: 1,
        recipe,
        dimensions,
        rows: [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      },
      bytes = Buffer.from(JSON.stringify(value)),
      temp = path + "." + randomUUID() + ".tmp";
    if (bytes.length > 6 * 1024 * 1024) throw new IndexIntegrityError("corrupt");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = await open(temp, "wx", 0o600);
    try {
      signal.throwIfAborted();
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      await rename(temp, path);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
    return {
      name,
      provider: "milvus",
      integrity: {
        schema: 1,
        format: "milvus-seal/1",
        digest: snapshotDigest(bytes),
        count: entries.length,
        recipe,
        pageSize: vectorPageSize(dimensions),
      },
    };
  }
  async read(
    ref: IndexReference,
    recipe: string,
    dimensions: number,
    signal: AbortSignal,
    force = false,
  ): Promise<LoadedVectorSeal> {
    const expected = ref.integrity;
    if (!expected) throw new IndexIntegrityError("unverified");
    if (
      ref.provider !== "milvus" ||
      expected.schema !== 1 ||
      expected.format !== "milvus-seal/1" ||
      expected.recipe !== recipe ||
      !/^[a-f0-9]{64}$/.test(expected.digest) ||
      !Number.isSafeInteger(expected.count) ||
      expected.count < 0 ||
      expected.count > MAX_VECTOR_ROWS ||
      expected.pageSize !== vectorPageSize(dimensions)
    )
      throw new IndexIntegrityError("corrupt");
    signal.throwIfAborted();
    const path = this.path(ref.name),
      cached = force ? undefined : this.cache.get(ref.name);
    if (
      cached &&
      cached.digest === expected.digest &&
      cached.value.rows.size === expected.count &&
      cached.value.dimensions === dimensions &&
      cached.stamp === (await inspectSnapshot(path))
    )
      return cached.value;
    this.cache.delete(ref.name);
    const { bytes, stamp } = await readIndexBytes(path, signal, 6 * 1024 * 1024);
    if (snapshotDigest(bytes) !== expected.digest) throw new IndexIntegrityError("corrupt");
    let value: VectorSeal;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      throw new IndexIntegrityError("corrupt");
    }
    if (
      !value ||
      value.schema !== 1 ||
      value.recipe !== recipe ||
      value.dimensions !== dimensions ||
      !Array.isArray(value.rows) ||
      value.rows.length !== expected.count
    )
      throw new IndexIntegrityError("corrupt");
    const rows = new Map<string, string>();
    for (const entry of value.rows) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry.some((p) => typeof p !== "string" || !/^[a-f0-9]{64}$/.test(p)) ||
        rows.has(entry[0])
      )
        throw new IndexIntegrityError("corrupt");
      rows.set(entry[0], entry[1]);
    }
    const loaded = { rows, dimensions, pageSize: expected.pageSize! };
    this.cache.set(ref.name, { digest: expected.digest, stamp, bytes: bytes.length, value: loaded });
    while (this.cache.size > 4 || [...this.cache.values()].reduce((n, v) => n + v.bytes, 0) > 16 * 1024 * 1024)
      this.cache.delete(this.cache.keys().next().value!);
    return loaded;
  }
  async drop(ref: IndexReference) {
    this.cache.delete(ref.name);
    await unlink(this.path(ref.name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
