import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CreationError } from "../contracts.js";
import type { CreationFileDirectory } from "./authored-files.js";
import {
  authoredDigest,
  CREATION_AUTHORED_TEXT_BYTES,
  type CreationFileVersion,
} from "./authored-file-version-records.js";

export interface AuthoredFileIdentity {
  dev: bigint;
  ino: bigint;
}
export async function authoredDirectory(directory: CreationFileDirectory) {
  await directory.verify();
  const stat = await lstat(directory.path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory.path)) !== directory.path)
    throw new CreationError("unavailable");
}
export async function authoredFile(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(CREATION_AUTHORED_TEXT_BYTES)) throw new CreationError("conflict");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      !named.isFile() ||
      named.isSymbolicLink()
    )
      throw new CreationError("conflict");
    return { dev: before.dev, ino: before.ino, digest: authoredDigest(bytes.subarray(0, length)), bytes: length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
const sameNode = (a: AuthoredFileIdentity, b: AuthoredFileIdentity) => a.dev === b.dev && a.ino === b.ino;
const sameText = (a: { digest: string; bytes: number } | null, b: CreationFileVersion) =>
  a?.digest === b.digest && a.bytes === b.bytes;
export async function authoredSync(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function assertAuthoredCurrent(version: CreationFileVersion) {
  if (!sameText(await authoredFile(join(version.directory, version.filename)), version))
    throw new CreationError("conflict");
}
/** A rename retains any racing user edit before publication. An exclusive link never replaces a newly created target. */
export async function publishAuthoredVersion(options: {
  directory: CreationFileDirectory;
  version: CreationFileVersion;
  previous: CreationFileVersion;
  prepared: string;
  backup: string;
  original: AuthoredFileIdentity;
  stagedIdentity: AuthoredFileIdentity;
  assertHeld(): void;
  afterStep?(step: "backed-up" | "published"): Promise<void>;
}) {
  const { directory, version, previous, prepared, backup } = options,
    target = join(directory.path, version.filename),
    staged = await authoredFile(prepared);
  if (!staged || !sameNode(staged, options.stagedIdentity) || !sameText(staged, version))
    throw new CreationError("conflict");
  let moved = false;
  try {
    let retained = await authoredFile(backup),
      current = await authoredFile(target);
    if (retained) {
      if (!sameText(retained, previous) || !sameNode(retained, options.original)) throw new CreationError("conflict");
      moved = true;
      if (current && sameNode(current, staged) && sameText(current, version)) return;
      if (current && sameText(current, previous) && sameNode(current, options.original)) {
        await unlink(backup);
        await authoredSync(directory.path);
        retained = null;
        moved = false;
      } else if (current) throw new CreationError("conflict");
    }
    if (!retained) {
      await assertAuthoredCurrent(previous);
      current = await authoredFile(target);
      if (!current || !sameNode(current, options.original)) throw new CreationError("conflict");
      await authoredDirectory(directory);
      options.assertHeld();
      await rename(target, backup);
      moved = true;
      await authoredSync(directory.path);
      await options.afterStep?.("backed-up");
      retained = await authoredFile(backup);
    }
    if (!retained || !sameText(retained, previous) || !sameNode(retained, options.original))
      throw new CreationError("conflict");
    await authoredDirectory(directory);
    options.assertHeld();
    try {
      await link(prepared, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    current = await authoredFile(target);
    if (!current || !sameNode(current, staged) || !sameText(current, version)) throw new CreationError("conflict");
    await authoredSync(directory.path);
    await options.afterStep?.("published");
    await authoredDirectory(directory);
    options.assertHeld();
  } catch (error) {
    // Undo a taken name without replacing another writer's file, including when authorization was revoked mid-operation.
    if (moved) {
      const retained = await authoredFile(backup);
      if (retained) {
        try {
          await link(backup, target);
          if (sameText(retained, previous)) await unlink(backup);
          await authoredSync(directory.path);
        } catch (restore) {
          if ((restore as NodeJS.ErrnoException).code !== "EEXIST")
            throw new AggregateError([error, restore], "Archive rollback failed", { cause: restore });
        }
      }
    }
    throw error;
  }
}
export async function cleanAuthoredVersion(
  path: string,
  expected: { digest: string; bytes: number },
  identity: AuthoredFileIdentity,
) {
  const current = await authoredFile(path);
  if (current && sameNode(current, identity) && current.digest === expected.digest && current.bytes === expected.bytes)
    await unlink(path);
}
