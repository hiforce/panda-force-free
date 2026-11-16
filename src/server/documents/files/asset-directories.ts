import { openProjectAssetDirectory, type OwnedAssetDirectory } from "../../project-content/asset-directory.js";
import { ProjectAssetBlobs } from "../../project-content/asset-blobs.js";
import type { OwnedProjectDirectory } from "../../project-content/owned-directory.js";

/** Binary ownership is pinned to a project repository; only explicit uploads may initialize its separate asset directory. */
export class DocumentAssetDirectories {
  private readonly directories = new Map<string, Promise<OwnedAssetDirectory>>();
  constructor(private readonly root: string) {}
  async open(owner: OwnedProjectDirectory, create = false): Promise<ProjectAssetBlobs> {
    const key = owner.projectId + ":" + owner.ownerId;
    let pending = this.directories.get(key);
    if (!pending) {
      pending = openProjectAssetDirectory(this.root, owner, { create });
      this.directories.set(key, pending);
    }
    try {
      const directory = await pending;
      await directory.verify();
      return new ProjectAssetBlobs(directory);
    } catch (error) {
      if (this.directories.get(key) === pending) this.directories.delete(key);
      throw error;
    }
  }
}
