import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inside } from "../../path-utils.js";
import { DocumentError } from "../errors.js";

/** Bounded, stable regular-file reads. Leaf symlinks and special files cannot become source input. */
export async function readSourceBytes(root: string, path: string, limit: number, singleLink = false): Promise<Buffer> {
  const full = resolve(root, path);
  if (!inside(full, root) || !inside(await realpath(full), root)) throw new DocumentError("outsideRoots", 403);
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat(),
      currentPath = await realpath(full);
    if (!before.isFile() || (singleLink && before.nlink !== 1)) throw new DocumentError("sourceUnavailable");
    if (before.size > limit) throw new DocumentError("assetTooLarge", 413);
    if (!inside(currentPath, root)) throw new DocumentError("outsideRoots", 403);
    const current = await stat(currentPath);
    if (current.dev !== before.dev || current.ino !== before.ino) throw new DocumentError("sourceUnavailable");
    const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new DocumentError("assetTooLarge", 413);
    const after = await file.stat();
    if (
      (singleLink && after.nlink !== 1) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      length !== after.size
    )
      throw new DocumentError("sourceUnavailable");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
export async function readSourceText(root: string, path: string, limit: number): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readSourceBytes(root, path, limit);
  } catch (error) {
    if (error instanceof DocumentError && error.code === "assetTooLarge") throw new DocumentError("tooLarge", 413);
    throw error;
  }
  const value = bytes.toString("utf8");
  if (value.includes("\0") || value.includes("\ufffd")) throw new DocumentError("sourceUnavailable");
  return value;
}
