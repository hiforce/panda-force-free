import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeAssetRecords, projectAssetFile } from "../../project-content/asset-file.js";
import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import { DocumentImageDecoder, imageUploadBytes, imageUploadName } from "../image-decoder.js";
import { DocumentError } from "../errors.js";
import { documentAuthor, documentOperationUuid } from "./commands.js";
import { documentIdentity, type DocumentFileProjects } from "./projects.js";
import { DocumentAssetDirectories } from "./asset-directories.js";
import { requireFileDocument } from "./source-access.js";
import { documentFileOperation } from "./errors.js";

/** Source image ownership enters project history only after its validated immutable bytes are durable outside Git. */
export class FileDocumentAssets {
  private readonly decoder = new DocumentImageDecoder();
  private readonly directories: DocumentAssetDirectories;
  constructor(
    private readonly projects: DocumentFileProjects,
    root: string,
  ) {
    this.directories = new DocumentAssetDirectories(root);
  }
  async list(projectId: string, documentId: string) {
    documentIdentity(documentId);
    return this.projects.view(projectId, async (project, view) => {
      await requireFileDocument(view, projectId, documentId);
      return project.assets.listIn(view, documentId);
    });
  }
  async metadata(projectId: string, assetId: string) {
    documentIdentity(assetId);
    return this.projects.view(projectId, async (project, view) => {
      const asset = await project.assets.lookup(view, assetId);
      await requireFileDocument(view, projectId, asset.documentId);
      return asset;
    });
  }
  async content(projectId: string, assetId: string) {
    documentIdentity(assetId);
    return documentFileOperation(async () => {
      const { asset, owner } = await this.projects.view(projectId, async (project, view) => {
          const asset = await project.assets.lookup(view, assetId);
          await requireFileDocument(view, projectId, asset.documentId);
          return { asset, owner: project.owned };
        }),
        blobs = await this.directories.open(owner),
        bytes = await blobs.read(asset.digest, asset.size);
      await this.projects.view(projectId, async (_project, view) =>
        requireFileDocument(view, projectId, asset.documentId),
      );
      return { asset, bytes };
    });
  }
  async upload(
    actor: string,
    projectId: string,
    documentId: string,
    name: string,
    operationId: string,
    input: Uint8Array,
  ): Promise<DocumentAsset> {
    documentIdentity(documentId);
    const id = documentOperationUuid(operationId),
      filename = imageUploadName(name),
      bytes = imageUploadBytes(input),
      author = documentAuthor(actor);
    await this.projects.view(projectId, async (_project, view) => requireFileDocument(view, projectId, documentId));
    const staged = await this.decoder.decode(filename, bytes);
    return this.projects.write(projectId, async (project) => {
      const blobs = await this.directories.open(project.owned, true);
      await blobs.put(staged.digest, staged.bytes);
      const result = await project.coordinator.plan(
          {
            operationId: id,
            author,
            message: "Register project document image",
            intent: stableJson({
              schema: 1,
              kind: "image-upload",
              projectId,
              documentId,
              name: staged.name,
              digest: staged.digest,
              mime: staged.mime,
              size: staged.size,
              width: staged.width,
              height: staged.height,
            }),
          },
          async (view) => {
            await requireFileDocument(view, projectId, documentId);
            const { bytes: _bytes, ...metadata } = staged,
              asset: DocumentAsset = { ...metadata, id, documentId, alt: "", createdAt: Date.now() };
            return { changes: [await project.assets.prepare(view, asset)] };
          },
        ),
        encoded = await new ProjectGitSnapshots(project.owned).fileAt(result.commit, projectAssetFile(id));
      if (encoded === null) throw new DocumentError("unavailable", 503);
      const asset = decodeAssetRecords(encoded).assets.find((row) => row.id === id);
      if (!asset || asset.documentId !== documentId) throw new DocumentError("unavailable", 503);
      return asset;
    });
  }
}
