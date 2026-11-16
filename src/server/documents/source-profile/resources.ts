import { readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { SourceResourceRule } from "../../../shared/sites/profile.js";
import { sourceRelativePath } from "../../../shared/sites/profile.js";
import { inside } from "../../path-utils.js";
import { readSourceBytes } from "../ingestion/files.js";
import { DocumentError } from "../errors.js";

export interface SourceResourceFile {
  path: string;
  data: string;
  sha256: string;
  publish: boolean;
}
/** Read only selected asset types; public output paths cannot overwrite engine files or dependency trees. */
export async function sourceResourceFiles(root: string, rules: SourceResourceRule[]): Promise<SourceResourceFile[]> {
  const files = new Map<string, SourceResourceFile>(),
    stamps = new Map<string, string>();
  let total = 0,
    visited = 0;
  for (const rule of rules) {
    async function walk(directory: string, suffix: string, depth: number) {
      if (depth > 12 || ++visited > 10000) throw new DocumentError("sourceResourcesTooLarge", 413);
      if (!inside(await realpath(directory), root)) throw new DocumentError("outsideRoots", 403);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 10000) throw new DocumentError("sourceResourcesTooLarge", 413);
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const relative = suffix + entry.name,
          source = rule.directory + "/" + relative;
        if (entry.isSymbolicLink()) throw new DocumentError("sourceUnavailable");
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), relative + "/", depth + 1);
          continue;
        }
        if (!entry.isFile() || !rule.extensions.includes(extname(entry.name).slice(1).toLowerCase())) continue;
        const path = sourceRelativePath(rule.target + "/" + relative),
          bytes = await readSourceBytes(root, source, 8 * 1024 * 1024),
          sha256 = createHash("sha256").update(bytes).digest("hex");
        const key = path.normalize("NFC").toLowerCase(),
          prior = files.get(key);
        if (prior && (prior.path !== path || prior.sha256 !== sha256 || prior.publish !== rule.publish))
          throw new DocumentError("sourceResourceConflict", 409);
        if (!prior) {
          total += bytes.length;
          if (total > 22 * 1024 * 1024 || files.size >= 500) throw new DocumentError("sourceResourcesTooLarge", 413);
          files.set(key, { path, data: bytes.toString("base64"), sha256, publish: rule.publish });
        }
        stamps.set(source, sha256);
      }
    }
    await walk(join(root, rule.directory), "", 0);
  }
  for (const [path, digest] of stamps)
    if (
      createHash("sha256")
        .update(await readSourceBytes(root, path, 8 * 1024 * 1024))
        .digest("hex") !== digest
    )
      throw new DocumentError("conflict", 409);
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}
