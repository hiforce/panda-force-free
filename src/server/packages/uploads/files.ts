import { open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import { errorCode } from "../../../shared/errors.js";
import { awaitSourceResult } from "../source-deadline.js";
import { readPackageFile, hashPackageFile } from "../file-bytes.js";
import type { SourceUploadBody, SourceUploadIdentity } from "./contracts.js";

const ORIGINAL = "original.upload";
export const SOURCE_UPLOAD_CHUNK_BYTES = 1024 * 1024;

function identity(value: SourceUploadIdentity): SourceUploadIdentity {
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SourceError("invalidSource");
  return Object.freeze({ bytes: value.bytes, sha256: value.sha256 });
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw new SourceError("sourceCancelled");
}
async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function removeTemporary(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Backpressure bounds owned buffers; a final name is published only after exact size, SHA and file sync. */
export async function writeSourceUpload(
  directory: string,
  value: SourceUploadIdentity,
  body: SourceUploadBody,
  signal: AbortSignal,
): Promise<void> {
  const expected = identity(value),
    temporary = join(directory, randomUUID() + ".upload-part"),
    hash = createHash("sha256");
  let complete = false;
  try {
    active(signal);
    const file = await open(temporary, "wx", 0o600);
    try {
      const iterator = body.chunks[Symbol.asyncIterator]();
      let length = 0;
      for (;;) {
        const next = await awaitSourceResult(iterator.next(), signal);
        active(signal);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) throw new SourceError("invalidSource");
        if (next.value.byteLength > SOURCE_UPLOAD_CHUNK_BYTES || next.value.byteLength > expected.bytes - length)
          throw new SourceError("sourceTooLarge");
        const bytes = new Uint8Array(next.value);
        hash.update(bytes);
        length += bytes.length;
        let offset = 0;
        while (offset < bytes.length) {
          active(signal);
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
          if (!bytesWritten) throw new SourceError("sourceUnavailable");
          offset += bytesWritten;
        }
      }
      if (length !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new SourceError("sourceChanged");
      await file.sync();
    } finally {
      await file.close();
    }
    active(signal);
    try {
      await link(temporary, join(directory, ORIGINAL));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await verifySourceUpload(directory, expected, signal);
    }
    await syncDirectory(directory);
    active(signal);
    complete = true;
  } finally {
    try {
      if (!complete) body.cancel();
    } finally {
      await removeTemporary(temporary);
    }
  }
}

export async function readSourceUpload(
  directory: string,
  value: SourceUploadIdentity,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const expected = identity(value);
  active(signal);
  const bytes = await readPackageFile(join(directory, ORIGINAL), expected.bytes);
  if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
    throw new SourceError("sourceChanged");
  active(signal);
  return bytes;
}
export async function recoverSourceUpload(
  directory: string,
  expected: SourceUploadIdentity,
  signal: AbortSignal,
): Promise<void> {
  await verifySourceUpload(directory, expected, signal);
  await syncDirectory(directory);
}
async function verifySourceUpload(directory: string, value: SourceUploadIdentity, signal: AbortSignal) {
  const expected = identity(value);
  active(signal);
  try {
    if ((await hashPackageFile(join(directory, ORIGINAL), expected.bytes, signal)) !== expected.sha256)
      throw new SourceError("sourceChanged");
  } catch (error) {
    if (signal.aborted) throw new SourceError("sourceCancelled");
    throw error;
  }
  active(signal);
}
export async function dropSourceUpload(directory: string): Promise<void> {
  try {
    await unlink(join(directory, ORIGINAL));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(directory);
}
