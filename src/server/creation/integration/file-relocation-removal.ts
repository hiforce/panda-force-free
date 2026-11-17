import { link, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CreationError } from "../contracts.js";
import type { CreationFileDirectory } from "./authored-files.js";
import type { CreationFileVersion } from "./authored-file-version-records.js";
import { authoredFile, authoredSync } from "./authored-file-version-publish.js";
import { openCreationDirectory } from "./conversation-directory.js";

/** Taking the name preserves a racing edit before its inode and bytes are checked; restoration never replaces a user file. */
export async function removeRelocatedFile(
  directory: CreationFileDirectory,
  expected: { id: string; owner: string; source: CreationFileVersion; dev: string; ino: string },
  conversationId: string,
  afterTaken?: () => Promise<void>,
) {
  await directory.verify();
  const retained = await openCreationDirectory(
    directory.path,
    "creation-transfer-" + expected.id,
    { kind: "file-relocation", owner: expected.owner, conversationId, id: expected.id },
    true,
  );
  if (!retained) throw new CreationError("unavailable");
  const path = join(directory.path, expected.source.filename),
    held = join(retained.path, "source.md"),
    same = (value: Awaited<ReturnType<typeof authoredFile>>) =>
      value &&
      String(value.dev) === expected.dev &&
      String(value.ino) === expected.ino &&
      value.digest === expected.source.digest &&
      value.bytes === expected.source.bytes;
  let taken = await authoredFile(held);
  if (!taken) {
    const current = await authoredFile(path);
    if (!current) return;
    if (!same(current)) throw new CreationError("conflict");
    await directory.verify();
    await retained.verify();
    await rename(path, held);
    await authoredSync(directory.path);
    await authoredSync(retained.path);
    await afterTaken?.();
    taken = await authoredFile(held);
  }
  if (!same(taken)) {
    if (taken) {
      try {
        await link(held, path);
        await authoredSync(directory.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new CreationError("conflict");
  }
  await directory.verify();
  await retained.verify();
  await unlink(held);
  await authoredSync(retained.path);
}
