import type { OriginalObjectStorage } from "../../object-storage/originals.js";
import type { OriginalScope } from "../../object-storage/original-codec.js";
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
export interface CreativeOriginalBytes {
  asset: CreativeAsset;
  bytes: Buffer;
  resources: { name: string; bytes: Buffer }[];
}
export type CreativeOriginalSnapshot = CreativeOriginalBytes | { asset: CreativeAsset; remote: OriginalScope };
export const creativeOriginalScope = (owner: OwnedProjectDirectory, id: string): OriginalScope => ({
  ownerId: owner.ownerId,
  projectId: owner.projectId,
  assetId: id,
});
/** Local files are captured under the Git lease. Object transfers require a separate lease-free phase. */
export class CreativeAssetFiles {
  constructor(
    private readonly root: string,
    private readonly objects?: OriginalObjectStorage,
  ) {}
  authorize(asset: CreativeAsset) {
    if (asset.originalStore !== "object") return;
    if (!this.objects) throw new ProjectContentError("unavailable");
    this.objects.assertAuthenticated();
  }
  async blobs(owner: OwnedProjectDirectory, create = false) {
    return new ProjectAssetBlobs(await openProjectAssetDirectory(this.root, owner, { create }), limits.sourceBytes);
  }
  async capture(
    view: ProjectContentView,
    owner: OwnedProjectDirectory,
    asset: CreativeAsset,
  ): Promise<CreativeOriginalSnapshot> {
    if (asset.originalStore === "object") {
      this.authorize(asset);
      if (!this.objects) throw new ProjectContentError("unavailable");
      view.assertHeld();
      return { asset, remote: creativeOriginalScope(owner, asset.id) };
    }
    return this.original(view, owner, asset);
  }
  async verifyReferences(owner: OwnedProjectDirectory, asset: CreativeAsset) {
    if (asset.originalStore !== "object") return;
    if (!this.objects) throw new ProjectContentError("unavailable");
    await this.objects.verifyReferences(creativeOriginalScope(owner, asset.id), [asset.source, ...asset.resources]);
  }
  deferred(snapshot: CreativeOriginalSnapshot) {
    return async (signal?: AbortSignal) => (await this.load(snapshot, signal)).bytes;
  }
  async load(snapshot: CreativeOriginalSnapshot, signal?: AbortSignal): Promise<CreativeOriginalBytes> {
    if (!("remote" in snapshot)) return snapshot;
    if (!this.objects) throw new ProjectContentError("unavailable");
    const { asset, remote } = snapshot,
      bytes = await this.objects.read(remote, asset.source, signal),
      resources: { name: string; bytes: Buffer }[] = [];
    for (const resource of asset.resources)
      resources.push({ name: resource.name, bytes: await this.objects.read(remote, resource, signal) });
    return { asset, bytes, resources };
  }
  async resource(
    snapshot: CreativeOriginalSnapshot,
    name?: string,
    signal?: AbortSignal,
    range?: { start: number; end: number },
  ) {
    const resource =
      name === undefined ? snapshot.asset.source : snapshot.asset.resources.find((row) => row.name === name);
    if (!resource) throw new ProjectContentError("notFound");
    if ("remote" in snapshot) {
      if (!this.objects) throw new ProjectContentError("unavailable");
      return this.objects.read(snapshot.remote, resource, signal, range);
    }
    const bytes = name === undefined ? snapshot.bytes : snapshot.resources.find((row) => row.name === name)!.bytes;
    return range ? bytes.subarray(range.start, range.end + 1) : bytes;
  }
  async original(view: ProjectContentView, owner: OwnedProjectDirectory, asset: CreativeAsset) {
    if (asset.originalStore === "object") throw new ProjectContentError("unavailable");
    const blobs = asset.kind !== "web" || asset.resources.length ? await this.blobs(owner) : null,
      bytes =
        asset.kind !== "web"
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
