import { IndexIntegrityError } from "../integrity.js";
import type { IndexReference } from "../ports.js";
import { MilvusStorage } from "./milvus-storage.js";
import { VectorSealStore, type LoadedVectorSeal } from "./vector-seal.js";
import { vectorRowDigest, type VectorRow } from "./vector-rows.js";

/** Exact known-ID batches avoid offset limits; total count also detects unknown extra rows. */
export async function verifyVectorRows(
  storage: MilvusStorage,
  name: string,
  seal: LoadedVectorSeal,
  ids: readonly string[],
  signal: AbortSignal,
  retain = true,
) {
  const values = new Map<string, Pick<VectorRow, "id" | "knowledge" | "version">>();
  for (let start = 0; start < ids.length; start += seal.pageSize) {
    signal.throwIfAborted();
    const batch = ids.slice(start, start + seal.pageSize),
      wanted = new Set(batch),
      rows = await storage.rows(name, batch, signal);
    if (rows.length !== batch.length) throw new IndexIntegrityError("corrupt");
    for (const row of rows) {
      if (!row || !wanted.delete(row.id) || seal.rows.get(row.id) !== vectorRowDigest(row, seal.dimensions))
        throw new IndexIntegrityError("corrupt");
      if (retain) values.set(row.id, { id: row.id, knowledge: row.knowledge, version: row.version });
    }
  }
  return values;
}
export async function auditVectorIndex(
  storage: MilvusStorage,
  seals: VectorSealStore,
  ref: IndexReference,
  recipe: string,
  dimensions: number,
  signal: AbortSignal,
) {
  const seal = await seals.read(ref, recipe, dimensions, signal, true);
  await storage.schema(ref.name, dimensions, signal);
  if ((await storage.count(ref.name, signal)) !== seal.rows.size) throw new IndexIntegrityError("corrupt");
  await verifyVectorRows(storage, ref.name, seal, [...seal.rows.keys()], signal, false);
  if ((await storage.count(ref.name, signal)) !== seal.rows.size) throw new IndexIntegrityError("corrupt");
  return {
    count: seal.rows.size,
    checks: ["seal-digest", "collection-schema", "strong-count", "all-chunk-versions-and-text", "all-float32-vectors"],
  };
}
