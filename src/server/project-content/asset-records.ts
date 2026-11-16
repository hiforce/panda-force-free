import type { DocumentAsset } from "../../shared/documents/contracts.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { ProjectContentError } from "./errors.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import type { ProjectContentView } from "./read-view.js";
import {
  decodeAssetRecord,
  decodeAssetRecords,
  encodeAssetRecords,
  projectAssetFile,
  projectAssetShard,
  type ProjectAssetRecords,
} from "./asset-file.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import { readProjectManifest } from "./project-manifest.js";
import { contentRequestHash } from "./mutation.js";
import { projectContentId } from "./paths.js";
import { stableJson } from "../../shared/stable-json.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";

/** Catalogs retain original names and ownership; binary availability is a separate storage port. */
export class ProjectAssetMetadata {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }
  private async shard(view: ProjectContentView, id: string): Promise<ProjectAssetRecords> {
    const bytes = await view.read(projectAssetFile(id)),
      shard = projectAssetShard(id),
      result: ProjectAssetRecords =
        bytes === null ? { schema: 1, projectId: this.owned.projectId, shard, assets: [] } : decodeAssetRecords(bytes);
    if (result.projectId !== this.owned.projectId || result.shard !== shard)
      throw new ProjectContentError("invalidFile");
    return result;
  }
  async get(id: string): Promise<DocumentAsset> {
    projectContentId(id);
    return this.coordinator.view((view) => this.lookup(view, id));
  }
  async lookup(view: ProjectContentView, id: string): Promise<DocumentAsset> {
    projectContentId(id);
    const result = (await this.shard(view, id)).assets.find((asset) => asset.id === id);
    if (!result) throw new ProjectContentError("notFound");
    return result;
  }
  async list(documentId: string): Promise<DocumentAsset[]> {
    projectContentId(documentId);
    return this.coordinator.view((view) => this.listIn(view, documentId));
  }
  async listIn(view: ProjectContentView, documentId: string): Promise<DocumentAsset[]> {
    projectContentId(documentId);
    await readProjectDocumentMetadata(view, documentId);
    const result: DocumentAsset[] = [];
    for (const path of view.paths.filter((path) => path.startsWith("asset-records/"))) {
      const bytes = await view.read(path);
      if (bytes === null) throw new ProjectContentError("conflict");
      const shard = decodeAssetRecords(bytes);
      if (shard.projectId !== this.owned.projectId || path !== "asset-records/" + shard.shard + ".panda.json")
        throw new ProjectContentError("invalidFile");
      result.push(...shard.assets.filter((asset) => asset.documentId === documentId));
    }
    return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en"));
  }
  /** One plan merges each shard once, including when several staged images hash to the same shard. */
  async prepareMany(view: ProjectContentView, input: readonly DocumentAsset[]) {
    if (input.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    const values = input.map(decodeAssetRecord),
      manifest = await readProjectManifest(view, this.owned.projectId),
      spaces = new Set(manifest.spaceIds),
      parents = new Set<string>();
    const shards = new Map<string, { record: ProjectAssetRecords; assets: Map<string, DocumentAsset> }>();
    for (const asset of values) {
      if (!parents.has(asset.documentId)) {
        const { document } = await readProjectDocumentMetadata(view, asset.documentId);
        if (!spaces.has(document.spaceId)) throw new ProjectContentError("invalidFile");
        parents.add(asset.documentId);
      }
      const id = projectAssetShard(asset.id);
      let shard = shards.get(id);
      if (!shard) {
        const record = await this.shard(view, asset.id);
        shard = { record, assets: new Map(record.assets.map((asset) => [asset.id, asset])) };
        shards.set(id, shard);
      }
      const existing = shard.assets.get(asset.id);
      if (existing && stableJson(existing) !== stableJson(asset)) throw new ProjectContentError("conflict");
      shard.assets.set(asset.id, asset);
    }
    return [...shards]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([id, value]) => ({
        path: "asset-records/" + id + ".panda.json",
        content: encodeAssetRecords({
          ...value.record,
          assets: [...value.assets.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
        }),
      }));
  }
  async prepare(view: ProjectContentView, input: DocumentAsset) {
    return (await this.prepareMany(view, [input]))[0]!;
  }

  async put(input: DocumentAsset, operationId: string, author: ContentAuthor): Promise<DocumentAsset> {
    const value = decodeAssetRecord(input),
      result = await this.coordinator.transact(
        {
          operationId,
          author,
          message: "Register project document asset",
          intent: stableJson({ schema: 1, kind: "asset-record", assetHash: contentRequestHash(value) }),
        },
        async (view) => [await this.prepare(view, value)],
      );
    const bytes = await this.snapshots.fileAt(result.commit, projectAssetFile(value.id));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const asset = decodeAssetRecords(bytes).assets.find((asset) => asset.id === value.id);
    if (!asset) throw new ProjectContentError("invalidFile");
    return asset;
  }
}
