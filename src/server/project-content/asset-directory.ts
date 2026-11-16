import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ProjectContentError } from "./errors.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ensureContentDirectory, readContentFile, syncContentDirectory } from "./working-files.js";

export interface OwnedAssetDirectory {
  readonly directory: string;
  readonly blobs: string;
  readonly projectId: string;
  readonly ownerId: string;
  verify(): Promise<void>;
}

/** Binary storage is separately owned and never adopts an unmarked directory or creates a Git repository. */
export async function openProjectAssetDirectory(
  root: string,
  owner: OwnedProjectDirectory,
  options: { create?: boolean } = {},
): Promise<OwnedAssetDirectory> {
  if (!isAbsolute(root)) throw new ProjectContentError("unowned");
  await owner.verify();
  const base = await realpath(root),
    projects = join(base, "projects"),
    directory = join(projects, owner.projectId),
    blobs = join(directory, "blobs"),
    marker = join(directory, ".panda-assets.json"),
    identity =
      JSON.stringify({
        schema: 1,
        product: "PandaForce document assets",
        projectId: owner.projectId,
        ownerId: owner.ownerId,
      }) + "\n";
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
  };
  if (within(owner.directory, directory) || within(directory, owner.directory))
    throw new ProjectContentError("unowned");
  let created = false;
  if (options.create !== false) {
    await ensureContentDirectory(projects);
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (created) {
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(identity);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ensureContentDirectory(blobs);
    await syncContentDirectory(directory);
    await syncContentDirectory(projects);
  }
  const verify = async () => {
    try {
      await owner.verify();
      for (const path of [projects, directory, blobs]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContentError("unowned");
      }
      const bytes = await readContentFile(marker, 4096);
      if (bytes?.toString() !== identity) throw new ProjectContentError("unowned");
    } catch (error) {
      if (error instanceof ProjectContentError) throw error;
      throw new ProjectContentError("unowned");
    }
  };
  await verify();
  const initial = await lstat(directory),
    initialBlobs = await lstat(blobs);
  return Object.freeze({
    directory,
    blobs,
    projectId: owner.projectId,
    ownerId: owner.ownerId,
    async verify() {
      await verify();
      const next = await lstat(directory),
        nextBlobs = await lstat(blobs);
      if (
        next.dev !== initial.dev ||
        next.ino !== initial.ino ||
        nextBlobs.dev !== initialBlobs.dev ||
        nextBlobs.ino !== initialBlobs.ino
      )
        throw new ProjectContentError("unowned");
    },
  });
}
