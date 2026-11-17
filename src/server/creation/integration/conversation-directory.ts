import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { readPackageFile } from "../../packages/file-bytes.js";
import { stableJson } from "../../../shared/stable-json.js";
import { CreationError } from "../contracts.js";

const markerName = ".panda-creation.json";
async function sync(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** A complete marked directory is published at once. Partial initialization never reserves the final conversation name. */
export async function openCreationDirectory(
  parent: string,
  leaf: string,
  identity: Record<string, unknown>,
  create: boolean,
) {
  if (basename(leaf) !== leaf || !/^[a-z0-9_-]{1,128}$/i.test(leaf)) throw new CreationError("invalidInput");
  const canonical = await realpath(parent),
    parentInfo = await lstat(parent),
    path = join(canonical, leaf),
    expected = stableJson({ schema: 1, product: "PandaForce creation directory", ...identity }) + "\n";
  if (canonical !== parent || !parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new CreationError("unavailable");
  const check = async () => {
    const currentParent = await lstat(canonical),
      info = await lstat(path);
    if (
      currentParent.dev !== parentInfo.dev ||
      currentParent.ino !== parentInfo.ino ||
      (await realpath(parent)) !== parent ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      new TextDecoder("utf-8", { fatal: true }).decode(await readPackageFile(join(path, markerName), 8192)) !== expected
    )
      throw new CreationError("unavailable");
    return info;
  };
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return null;
    const staged = await mkdtemp(join(canonical, ".creation-directory-"));
    try {
      const marker = await open(join(staged, markerName), "wx", 0o600);
      try {
        await marker.writeFile(expected);
        await marker.sync();
      } finally {
        await marker.close();
      }
      await sync(staged);
      // A concurrent complete publisher has a non-empty destination, so rename cannot replace it.
      try {
        await rename(staged, path);
      } catch (publish) {
        if (!["EEXIST", "ENOTEMPTY"].includes((publish as NodeJS.ErrnoException).code || "")) throw publish;
      }
      await sync(canonical);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  const opened = await check();
  return {
    path,
    verify: async () => {
      const current = await check();
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new CreationError("unavailable");
    },
  };
}
