import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { CreationError, type CreationTaskSpec } from "../contracts.js";
import { creationText } from "../validation.js";
import type { CreationFileDirectories } from "../file-directories.js";
import { authoredDigest } from "./authored-file-version-records.js";

/** Existing code directories are authorized and verified without adopting their contents or placing ownership markers. */
export function creationCodeDirectories(options: {
  root(task: CreationTaskSpec): Promise<string>;
  authorize(task: CreationTaskSpec): Promise<void>;
}): CreationFileDirectories {
  const root = async (task: CreationTaskSpec) => {
    await options.authorize(task);
    const path = await options.root(task);
    if (!isAbsolute(path) || resolve(path) !== path) throw new CreationError("unavailable");
    return path;
  };
  return {
    async describe(task) {
      const path = await root(task),
        stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
        throw new CreationError("unavailable");
      return { root: path };
    },
    async open(task, input) {
      const anchor = await root(task),
        requested = creationText(input, 4096),
        path = resolve(anchor, requested),
        suffix = relative(anchor, path);
      if (
        /\p{Cc}|\\/u.test(requested) ||
        suffix === ".." ||
        suffix.startsWith(".." + sep) ||
        isAbsolute(suffix) ||
        suffix.split(sep).some((part) => part.startsWith("."))
      )
        throw new CreationError("invalidInput");
      const names = suffix ? suffix.split(sep) : [];
      if (names.length > 32) throw new CreationError("invalidInput");
      const inspect = async () => {
        await options.authorize(task);
        if ((await root(task)) !== anchor) throw new CreationError("conflict");
        const nodes: { path: string; dev: string; ino: string }[] = [];
        let current = anchor;
        for (const part of ["", ...names]) {
          current = part ? join(current, part) : current;
          const stat = await lstat(current, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
            throw new CreationError("conflict");
          nodes.push({ path: current, dev: String(stat.dev), ino: String(stat.ino) });
        }
        return authoredDigest(stableJson(nodes));
      };
      const identity = await inspect();
      return {
        path,
        identity,
        verify: async () => {
          if ((await inspect()) !== identity) throw new CreationError("conflict");
        },
      };
    },
  };
}
