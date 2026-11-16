import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { SEARCH_LIMITS } from "../../../shared/search/contracts.js";
import { IndexIntegrityError } from "../integrity.js";
import type { IndexReference } from "../ports.js";
export const LOCAL_INDEX_FINGERPRINT = "minisearch/7.2.0/schema2";
export const canRetireLocalIndex = (fingerprint: string) =>
  fingerprint === LOCAL_INDEX_FINGERPRINT || fingerprint === "minisearch/7.2.0/schema1";

export const snapshotDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function snapshotStamp(stat: Stats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SEARCH_LIMITS.indexBytes)
    throw new IndexIntegrityError("corrupt");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
export function snapshotFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") throw new IndexIntegrityError("missing");
  if (code === "ELOOP") throw new IndexIntegrityError("corrupt");
  throw error;
}
export async function inspectSnapshot(path: string) {
  try {
    return snapshotStamp(await lstat(path));
  } catch (error) {
    return snapshotFailure(error);
  }
}
/** The worker verifies full immutable bytes on load; a hot query only checks bounded file metadata. */
export async function readIndexBytes(path: string, signal?: AbortSignal, maxBytes = SEARCH_LIMITS.indexBytes) {
  signal?.throwIfAborted();
  await inspectSnapshot(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    snapshotFailure,
  );
  try {
    signal?.throwIfAborted();
    const info = await file.stat(),
      before = snapshotStamp(info),
      chunks: Buffer[] = [];
    if (info.size > maxBytes) throw new IndexIntegrityError("corrupt");
    for (let offset = 0; offset < info.size;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65536, info.size - offset)),
        { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw new IndexIntegrityError("corrupt");
      chunks.push(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const bytes = Buffer.concat(chunks, info.size);
    signal?.throwIfAborted();
    if (bytes.length > SEARCH_LIMITS.indexBytes || before !== snapshotStamp(await file.stat()))
      throw new IndexIntegrityError("corrupt");
    return { bytes, stamp: before };
  } finally {
    await file.close();
  }
}

export async function readSnapshot(path: string, ref: IndexReference, recipe: string, signal?: AbortSignal) {
  const { bytes, stamp: before } = await readIndexBytes(path, signal);
  const digest = snapshotDigest(bytes);
  let value;
  try {
    value = JSON.parse(bytes.toString());
  } catch {
    throw new IndexIntegrityError("corrupt");
  }
  if (!value || value.schema !== 1 || value.analyzer !== recipe || !value.index)
    throw new IndexIntegrityError("corrupt");
  const expected = ref.integrity;
  if (
    expected &&
    (expected.schema !== 1 ||
      expected.format !== "local-json/1" ||
      expected.recipe !== recipe ||
      expected.digest !== digest ||
      expected.count !== value.index.documentCount)
  )
    throw new IndexIntegrityError("corrupt");
  return { value, digest, stamp: before, bytes: bytes.length };
}
