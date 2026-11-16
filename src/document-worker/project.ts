import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BuildInput } from "../shared/builds/contracts.js";
import { BuildError } from "../shared/builds/validation.js";

/** Output projection is separate from engine generation and never follows theme-created symlinks. */
export async function publishProjectResources(input: BuildInput, output: string) {
  for (const file of input.project?.files || []) {
    if (!file.publish) continue;
    const segments = file.path.split("/");
    let directory = output;
    if ((await lstat(directory)).isSymbolicLink()) throw new BuildError("unsafeOutput");
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BuildError("unsafeOutput");
    }
    const target = join(output, file.path);
    try {
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex") !== file.sha256
      )
        throw new BuildError("sourceResourceConflict");
      continue;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.from(file.data, "base64"));
    } finally {
      await handle.close();
    }
  }
}
