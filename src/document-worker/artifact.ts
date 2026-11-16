import { readdir, lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import type { BuildArtifact } from "../shared/builds/contracts.js";
import { BUILD_LIMITS, safeBuildPath, BuildError } from "../shared/builds/validation.js";

/** Reject links and oversized output before the executor accepts any generated file. */
export async function collectArtifact(root: string): Promise<BuildArtifact> {
  const artifact: BuildArtifact = { protocol: 1, files: [], bytes: 0 },
    base = await realpath(root);
  async function walk(prefix: string) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const relative = safeBuildPath(prefix + entry.name),
        path = join(root, relative),
        stat = await lstat(path);
      if (stat.isSymbolicLink() || !(await realpath(path)).startsWith(base + sep)) throw new BuildError("unsafeOutput");
      if (stat.isDirectory()) await walk(relative + "/");
      else if (stat.isFile()) {
        artifact.bytes += stat.size;
        if (artifact.bytes > BUILD_LIMITS.outputBytes || artifact.files.length >= BUILD_LIMITS.files)
          throw new BuildError("artifactTooLarge");
        const bytes = await readFile(path);
        artifact.files.push({
          path: relative,
          data: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else throw new BuildError("unsafeOutput");
    }
  }
  await walk("");
  artifact.files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return artifact;
}
