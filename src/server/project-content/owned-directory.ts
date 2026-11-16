import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { projectContentId } from "./paths.js";
import { ProjectContentError } from "./errors.js";
import { projectGit } from "./git/process.js";

interface Ownership {
  schema: 1;
  product: "PandaForce project content";
  projectId: string;
  ownerId: string;
  configHash: string;
  coordination: string;
}

export interface OwnedProjectDirectory {
  readonly directory: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly coordination: string;
  verify(): Promise<void>;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function directory(path: string, create = false): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContentError("unowned");
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new ProjectContentError("unowned");
    const result = await handle.readFile();
    if (result.length > maximum) throw new ProjectContentError("unowned");
    return result;
  } finally {
    await handle.close();
  }
}

async function durableNewFile(path: string, bytes: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function projectBase(root: string): Promise<string> {
  if (!root || !isAbsolute(root)) throw new ProjectContentError("unowned");
  // The configured root may resolve through an administrator's NAS mount; project children may not be symlinks.
  return join(await realpath(root), "projects");
}
async function projectPath(root: string, projectId: string, create = false): Promise<string> {
  projectContentId(projectId);
  const projects = await projectBase(root);
  await directory(projects, create);
  return join(projects, projectId);
}

/** A missing project is different from an unowned or interrupted repository; optional reads never mask the latter. */
export async function findOwnedProjectDirectory(
  root: string,
  projectId: string,
): Promise<OwnedProjectDirectory | null> {
  projectContentId(projectId);
  const projects = await projectBase(root);
  try {
    await directory(projects);
    await lstat(join(projects, projectId));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return openOwnedProjectDirectory(root, projectId);
}

/** Only a dedicated, marked repository is accepted. Existing source repositories are never adopted or reset. */
export async function openOwnedProjectDirectory(root: string, projectId: string): Promise<OwnedProjectDirectory> {
  const path = await projectPath(root, projectId);
  const verify = async (): Promise<Ownership> => {
    try {
      for (const part of [
        path,
        join(path, ".git"),
        join(path, ".git", "objects"),
        join(path, ".git", "objects", "info"),
        join(path, ".git", "objects", "pack"),
        join(path, ".git", "refs"),
        join(path, ".git", "refs", "heads"),
        join(path, ".git", "refs", "panda"),
      ])
        await directory(part);
      for (const part of [join(path, ".git", "commondir"), join(path, ".git", "objects", "info", "alternates")]) {
        try {
          await lstat(part);
          throw new ProjectContentError("unowned");
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      const value: unknown = JSON.parse(
        (await boundedFile(join(path, ".git", "panda-owner.json"), 4096)).toString("utf8"),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectContentError("unowned");
      const marker = value as Ownership;
      if (
        marker.schema !== 1 ||
        marker.product !== "PandaForce project content" ||
        marker.projectId !== projectId ||
        typeof marker.ownerId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(marker.ownerId) ||
        typeof marker.coordination !== "string" ||
        !/^[a-f0-9]{40}$/.test(marker.coordination) ||
        marker.configHash !== sha(await boundedFile(join(path, ".git", "config"), 16384)) ||
        (await boundedFile(join(path, ".git", "HEAD"), 128)).toString() !== "ref: refs/heads/content\n"
      )
        throw new ProjectContentError("unowned");
      return marker;
    } catch (error) {
      if (error instanceof ProjectContentError) throw error;
      throw new ProjectContentError("unowned");
    }
  };
  const marker = await verify(),
    info = await lstat(path),
    git = await lstat(join(path, ".git"));
  return Object.freeze({
    directory: path,
    projectId,
    ownerId: marker.ownerId,
    coordination: marker.coordination,
    async verify() {
      const current = await verify(),
        next = await lstat(path),
        nextGit = await lstat(join(path, ".git"));
      if (
        current.ownerId !== marker.ownerId ||
        next.dev !== info.dev ||
        next.ino !== info.ino ||
        nextGit.dev !== git.dev ||
        nextGit.ino !== git.ino
      )
        throw new ProjectContentError("unowned");
    },
  });
}

/** Interrupted initialization remains explicitly unowned; no automatic deletion or adoption of its directory occurs. */
export async function createOwnedProjectDirectory(root: string, projectId: string): Promise<OwnedProjectDirectory> {
  const path = await projectPath(root, projectId, true);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return openOwnedProjectDirectory(root, projectId);
    throw error;
  }
  const bootstrap = join(path, ".panda-initialize.json");
  await durableNewFile(bootstrap, JSON.stringify({ schema: 1, projectId, ownerId: randomUUID() }) + "\n");
  await projectGit(path, ["init", "--template=", "--object-format=sha1", "--initial-branch=content"]);
  const tree = (await projectGit(path, ["mktree"], { input: "" })).toString().trim();
  const coordination = (
    await projectGit(path, ["commit-tree", tree], {
      input: "Initialize project content\n",
      identity: { name: "PandaForce", email: "content@pandaforce.local" },
    })
  )
    .toString()
    .trim();
  await projectGit(path, ["update-ref", "refs/heads/content", coordination]);
  await projectGit(path, ["update-ref", "refs/panda/coordination", coordination]);
  const marker: Ownership = {
    schema: 1,
    product: "PandaForce project content",
    projectId,
    ownerId: JSON.parse(await readFile(bootstrap, "utf8")).ownerId as string,
    configHash: sha(await boundedFile(join(path, ".git", "config"), 16384)),
    coordination,
  };
  await durableNewFile(join(path, ".git", "panda-owner.json"), JSON.stringify(marker) + "\n");
  await unlink(bootstrap);
  for (const part of [join(path, ".git"), path, join(path, "..")]) {
    const handle = await open(part, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return openOwnedProjectDirectory(root, projectId);
}
