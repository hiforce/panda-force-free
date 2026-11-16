import { ProjectAssetBlobs } from "../../project-content/asset-blobs.js";
import { openProjectAssetDirectory } from "../../project-content/asset-directory.js";
import type { OwnedProjectDirectory } from "../../project-content/owned-directory.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { projectCreationFile, projectCreationHtml } from "../../project-content/paths.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { CREATIVE_ASSET_LIMITS as limits, type CreativeAsset } from "../../../shared/creative/assets.js";
import { creativeAssetId, creativeDigest, decodeCreativeAsset } from "./codec.js";

export async function creativeMetadata(view: ProjectContentView, project: string, id: string, trashed = false) {
  creativeAssetId(id);
  const bytes = await view.read(projectCreationFile(id));
  if (!bytes) throw new ProjectContentError("notFound");
  const asset = decodeCreativeAsset(bytes);
  if (asset.id !== id || asset.project !== project) throw new ProjectContentError("invalidFile");
  if (!trashed && asset.state !== "saved") throw new ProjectContentError("notFound");
  return asset;
}
/** Files are verified under the owning Git lease; parsing belongs to the caller's lease-free phase. */
export class CreativeAssetFiles {
  constructor(private readonly root: string) {}
  async blobs(owner: OwnedProjectDirectory, create = false) {
    return new ProjectAssetBlobs(await openProjectAssetDirectory(this.root, owner, { create }), limits.sourceBytes);
  }
  async original(view: ProjectContentView, owner: OwnedProjectDirectory, asset: CreativeAsset) {
    const blobs = asset.kind === "slides" || asset.resources.length ? await this.blobs(owner) : null,
      bytes =
        asset.kind === "slides"
          ? await blobs!.read(asset.source.digest, asset.source.size)
          : await view.read(projectCreationHtml(asset.id));
    if (!bytes || bytes.length !== asset.source.size || creativeDigest(bytes) !== asset.source.digest)
      throw new ProjectContentError("invalidFile");
    const resources: { name: string; bytes: Buffer }[] = [];
    for (const resource of asset.resources) {
      const bytes = resource.size ? await blobs!.read(resource.digest, resource.size) : Buffer.alloc(0);
      if (creativeDigest(bytes) !== resource.digest) throw new ProjectContentError("invalidFile");
      resources.push({ name: resource.name, bytes });
    }
    view.assertHeld();
    return { asset, bytes, resources };
  }
}
