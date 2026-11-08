import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ProjectError } from "../catalog.js";
import type { ProjectWorkspaceBinding } from "./repository.js";

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readMarker(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid workspace marker");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
/** Only an exclusively created or exactly marked directory can become an engine workspace. */
export class ProjectWorkspaceDirectory {
  private rootIdentity: { dev: number; ino: number } | null = null;
  constructor(readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root)
      throw new Error("Project workspace root must be absolute and normalized");
  }
  async initialize(): Promise<void> {
    await this.verifyRoot(true);
  }
  private async verifyRoot(create = false) {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(this.root)) !== this.root)
      throw new ProjectError(409, "projects.errorWorkspaceConflict");
    if (this.rootIdentity && (stat.dev !== this.rootIdentity.dev || stat.ino !== this.rootIdentity.ino))
      throw new ProjectError(409, "projects.errorWorkspaceConflict");
    this.rootIdentity = { dev: stat.dev, ino: stat.ino };
  }
  async assertAvailable(code: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code)) throw new ProjectError(400, "projects.errorInvalidProjectDetails");
    await this.verifyRoot(true);
    try {
      await lstat(join(this.root, code));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new ProjectError(409, "projects.errorWorkspaceConflict");
  }
  async prepare(binding: ProjectWorkspaceBinding): Promise<void> {
    if (
      binding.root !== this.root ||
      !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(binding.code) ||
      binding.path !== join(this.root, binding.code)
    )
      throw new ProjectError(409, "projects.errorWorkspaceConflict");
    await this.verifyRoot(binding.state === "preparing");
    const marker = join(binding.path, ".panda-workspace.json"),
      identity =
        JSON.stringify({
          schema: 1,
          product: "PandaForce project workspace",
          projectId: binding.projectId,
          code: binding.code,
          ownerId: binding.ownerId,
        }) + "\n";
    let created = false;
    if (binding.state === "preparing") {
      try {
        await mkdir(binding.path, { mode: 0o700 });
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
      await syncDirectory(binding.path);
      await syncDirectory(this.root);
    }
    try {
      const stat = await lstat(binding.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await readMarker(marker)) !== identity)
        throw new Error("Workspace ownership mismatch");
      await this.verifyRoot();
    } catch {
      throw new ProjectError(409, "projects.errorWorkspaceConflict");
    }
  }
}
