import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import {
  createOwnedProjectDirectory,
  openOwnedProjectDirectory,
  type OwnedProjectDirectory,
} from "../../project-content/owned-directory.js";
import { queueProjectContent } from "../../project-content/queue.js";
import { withProjectGitLease, type ProjectGitLease } from "../../project-content/git/lease.js";
import { creationText } from "../validation.js";

/** Coordination lives in private application state, never in a user's source repository. */
export class CreationAuthoredFileLeases {
  private readonly owners = new Map<string, Promise<OwnedProjectDirectory>>();
  constructor(private readonly root: string) {}
  private async owner(value: string) {
    const id = "archive-" + createHash("sha256").update(creationText(value, 200)).digest("hex");
    let opened = this.owners.get(id);
    if (!opened) {
      opened = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const root = await realpath(this.root),
          projects = join(root, "projects");
        await mkdir(projects, { recursive: true, mode: 0o700 });
        const parent = await lstat(projects);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("Archive coordination directory unavailable");
        try {
          await lstat(join(projects, id));
          return openOwnedProjectDirectory(root, id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const staging = await mkdtemp(join(root, ".archive-coordination-"));
        try {
          const prepared = await createOwnedProjectDirectory(staging, id);
          try {
            await rename(prepared.directory, join(projects, id));
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
          }
          const published = await open(projects, "r");
          try {
            await published.sync();
          } finally {
            await published.close();
          }
          return openOwnedProjectDirectory(root, id);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      })();
      this.owners.set(id, opened);
    }
    try {
      return await opened;
    } catch (error) {
      if (this.owners.get(id) === opened) this.owners.delete(id);
      throw error;
    }
  }
  async run<T>(owner: string, work: (lease: ProjectGitLease) => Promise<T>) {
    const opened = await this.owner(owner);
    return queueProjectContent(opened.directory, async () => {
      await opened.verify();
      return withProjectGitLease(opened.directory, opened.coordination, work, { waitForLockMs: 25000 });
    });
  }
}
