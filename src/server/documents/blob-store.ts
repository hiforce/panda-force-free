import { mkdir, open, link, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DocumentError } from "./errors.js";

/** Publish complete immutable files atomically, including when independent importers share a blob. */
export async function storeDocumentBlob(root: string, digest: string, bytes: Buffer) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, digest),
    temporary = join(root, `${digest}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex") !== digest
      )
        throw new DocumentError("sourceUnavailable", 503);
    }
  } finally {
    await unlink(temporary);
  }
}
