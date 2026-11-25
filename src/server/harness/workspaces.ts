import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HarnessError } from "../../shared/harness/contracts.js";
import { creativeImportKind, creativeKindMatchesName } from "../../shared/creative/file-types.js";
import { CREATIVE_ASSET_LIMITS } from "../../shared/creative/assets.js";
import { readSourceBytes } from "../documents/ingestion/files.js";

export async function createHarnessWorkspace(root: string, prefix: string, hostSocket = false) {
  let cwd: string;
  if (hostSocket) {
    // Group permissions also bound inherited POSIX ACL entries for the host user.
    const sharedMode = (await stat(root)).mode & 0o070;
    cwd = join(root, prefix + randomUUID());
    await mkdir(cwd, { mode: 0o700 | sharedMode });
  } else cwd = await mkdtemp(join(root, prefix));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

function outputFilename(name: string) {
  const kind = creativeImportKind(name);
  return (
    !!name &&
    name.length <= 200 &&
    !name.startsWith(".") &&
    name === basename(name) &&
    !/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(name) &&
    kind !== "file" &&
    creativeKindMatchesName(kind, name)
  );
}

/** Native file tools can write a finished leaf only in the task's already isolated working directory. */
export async function allowsHarnessOutputWrite(cwd: string, requested: unknown) {
  if (typeof requested !== "string" || !requested) return false;
  const path = resolve(cwd, requested);
  if (dirname(path) !== cwd || !outputFilename(basename(path))) return false;
  try {
    const current = await lstat(path);
    return current.isFile() && current.nlink === 1;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** The run's workspace grants access to one finished file, never a model-supplied path. */
export async function harnessOutputReader(cwd: string) {
  const root = await realpath(cwd),
    identity = await lstat(root);
  return async (name: string) => {
    if (!outputFilename(name)) throw new HarnessError("invalidInput");
    const verify = async () => {
      const current = await lstat(root);
      if (
        !current.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        (await realpath(root)) !== root
      )
        throw new HarnessError("workspaceUnavailable", 409);
    };
    await verify();
    const bytes = await readSourceBytes(root, name, CREATIVE_ASSET_LIMITS.sourceBytes, true);
    await verify();
    return bytes;
  };
}
