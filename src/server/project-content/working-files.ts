import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ProjectContentError } from "./errors.js";
import { projectFilePath } from "./paths.js";
import { boundedFileReadLength, type ProjectFileReader } from "./file-reader.js";

export const isMissingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function syncContentDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureContentDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncContentDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProjectContentError("unowned");
}

export async function readContentFile(path: string, maximum: number): Promise<Buffer | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new ProjectContentError("invalidFile");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maximum - total + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new ProjectContentError("invalidFile");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

export async function replaceContentFile(
  path: string,
  bytes: Uint8Array,
  beforeRename: () => void | Promise<void>,
): Promise<void> {
  const temporary = join(dirname(path), ".panda-write-" + randomUUID());
  const file = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    closed = true;
    await beforeRename();
    await rename(temporary, path);
    await syncContentDirectory(dirname(path));
  } finally {
    if (!closed) await file.close();
    await unlink(temporary).catch((error) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

/** Worktree reads and replacements are limited to the same closed content paths as Git snapshots. */
export class ProjectWorkingFiles {
  constructor(private readonly owned: OwnedProjectDirectory) {}

  private async parent(path: string, create: boolean): Promise<string> {
    projectFilePath(path);
    const target = join(this.owned.directory, path),
      parent = dirname(target);
    if (parent !== this.owned.directory) {
      if (create) await ensureContentDirectory(parent);
      else {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContentError("unowned");
      }
    }
    return target;
  }

  async read(path: string): Promise<Buffer | null> {
    try {
      return await readContentFile(await this.parent(path, false), PROJECT_CONTENT_LIMITS.fileBytes);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async inspect<T>(path: string, work: (file: ProjectFileReader) => Promise<T>): Promise<T> {
    const target = await this.parent(path, false),
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let active = true;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > PROJECT_CONTENT_LIMITS.fileBytes)
        throw new ProjectContentError("invalidFile");
      const result = await work(
        Object.freeze({
          size: before.size,
          async read(offset: number, length: number) {
            if (!active) throw new ProjectContentError("unavailable");
            const buffer = Buffer.allocUnsafe(boundedFileReadLength(before.size, offset, length));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (!active) throw new ProjectContentError("unavailable");
            return buffer.subarray(0, bytesRead);
          },
        }),
      );
      const after = await file.stat(),
        current = await lstat(target);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.isSymbolicLink()
      )
        throw new ProjectContentError("conflict");
      return result;
    } finally {
      active = false;
      await file.close();
    }
  }

  async replace(path: string, before: Buffer | null, after: Buffer | null, assertHeld: () => void): Promise<void> {
    const same = (value: Buffer | null) => (before === null ? value === null : !!value?.equals(before));
    if (!same(await this.read(path))) throw new ProjectContentError("conflict");
    if (after === null && before === null) return;
    const target = await this.parent(path, after !== null);
    await this.owned.verify();
    if (after !== null) {
      await replaceContentFile(target, after, async () => {
        await this.owned.verify();
        if (!same(await this.read(path))) throw new ProjectContentError("conflict");
        assertHeld();
      });
    } else {
      assertHeld();
      await unlink(target);
      await syncContentDirectory(dirname(target));
    }
  }
}
