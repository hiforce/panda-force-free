import { createHash } from "node:crypto";
import type { SearchVectorDocument } from "../ports.js";
import { SEARCH_LIMITS, SearchError } from "../../../shared/search/contracts.js";
import { IndexIntegrityError } from "../integrity.js";
export interface VectorChunk {
  id: string;
  knowledge: string;
  version: string;
  text: string;
  start: number;
}
export interface VectorRow extends VectorChunk {
  vector: number[];
}
export const MAX_VECTOR_ROWS = 24000;
export const vectorPageSize = (dimensions: number) =>
  Math.max(1, Math.min(128, Math.floor((2 * 1024 * 1024) / (dimensions * 28 + 12000))));

/** Digests use float32 bytes, independent of a REST server's decimal JSON formatting. */
export function float32Vector(value: unknown, dimensions: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== dimensions ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new IndexIntegrityError("corrupt");
  const vector = value.map((n) => Math.fround(n) || 0);
  if (vector.some((n) => !Number.isFinite(n)) || !vector.some((n) => n !== 0)) throw new IndexIntegrityError("corrupt");
  return vector;
}
export function vectorRowDigest(value: unknown, dimensions: number) {
  const row = value as VectorRow;
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.id) ||
    typeof row.knowledge !== "string" ||
    !row.knowledge ||
    row.knowledge.length > 128 ||
    typeof row.version !== "string" ||
    !row.version ||
    row.version.length > 160 ||
    typeof row.text !== "string" ||
    row.text.length > SEARCH_LIMITS.chunkCharacters * 2 ||
    !Number.isSafeInteger(row.start) ||
    row.start < 0
  )
    throw new IndexIntegrityError("corrupt");
  const vector = float32Vector(row.vector, dimensions),
    bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((n, i) => bytes.writeFloatLE(n, i * 4));
  return createHash("sha256")
    .update(JSON.stringify([row.id, row.knowledge, row.version, row.text, row.start]))
    .update(bytes)
    .digest("hex");
}
/** Chunk offsets count Unicode characters; an astral character is never split at a surrogate boundary. */
export function vectorChunks(documents: SearchVectorDocument[]): VectorChunk[] {
  const rows: VectorChunk[] = [],
    ids = new Set<string>();
  for (const d of documents) {
    if (
      !d ||
      typeof d.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(d.id) ||
      typeof d.version !== "string" ||
      !d.version ||
      d.version.length > 160 ||
      typeof d.title !== "string" ||
      typeof d.text !== "string" ||
      d.title.length + d.text.length > SEARCH_LIMITS.vectorChunks * SEARCH_LIMITS.chunkCharacters * 2
    )
      throw new SearchError("invalidInput");
    if (ids.has(d.id)) throw new SearchError("invalidInput");
    ids.add(d.id);
    const text = Array.from(d.title + "\n" + d.text);
    let chunks = 0;
    for (let start = 0; start < text.length; start += SEARCH_LIMITS.chunkCharacters - 160) {
      if (++chunks > SEARCH_LIMITS.vectorChunks || rows.length >= MAX_VECTOR_ROWS) throw new SearchError("limit", 409);
      const part = text.slice(start, start + SEARCH_LIMITS.chunkCharacters).join("");
      rows.push({
        id: createHash("sha256")
          .update(JSON.stringify([d.id, d.version, start, part]))
          .digest("hex"),
        knowledge: d.id,
        version: d.version,
        text: part,
        start,
      });
      if (start + SEARCH_LIMITS.chunkCharacters >= text.length) break;
    }
  }
  return rows;
}
