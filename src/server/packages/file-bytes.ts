import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export class PackageContentError extends Error {
  constructor(
    message: string,
    readonly retryableLinkTransition = false,
  ) {
    super(message);
  }
}

/** Immutable package files are bounded before allocation and checked for replacement or growth after reading. */
export async function readPackageFile(path: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new PackageContentError("contentUnavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new PackageContentError("contentUnavailable");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new PackageContentError(
        "contentUnavailable",
        offset === before.size &&
          before.size === after.size &&
          before.ino === after.ino &&
          before.dev === after.dev &&
          before.mtimeMs === after.mtimeMs &&
          before.nlink === 2 &&
          after.nlink === 1,
      );
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** Recovery checks original upload bytes with a fixed buffer rather than hydrating the archive. */
export async function hashPackageFile(path: string, expectedBytes: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new PackageContentError("contentUnavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    hash = createHash("sha256");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== expectedBytes) throw new PackageContentError("contentUnavailable");
    const buffer = Buffer.alloc(Math.min(65536, expectedBytes + 1));
    let length = 0;
    for (;;) {
      if (signal?.aborted) throw new PackageContentError("contentCancelled");
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expectedBytes + 1 - length), length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > expectedBytes) throw new PackageContentError("contentUnavailable");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      length !== expectedBytes ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new PackageContentError("contentUnavailable");
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}
