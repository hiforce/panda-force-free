import { randomUUID } from "node:crypto";
import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import { richImageId, type RichTextNode } from "../../../shared/documents/rich-body.js";
import type { PreparedDocumentCreation } from "../creation-port.js";
import type { ProjectContentProject } from "../../project-content/project.js";
import { DocumentAssetDirectories } from "./asset-directories.js";
import { DocumentImageDecoder, imageUploadBytes } from "../image-decoder.js";
import { richDocumentInput } from "../rich-codec.js";
import { DocumentError } from "../errors.js";

/** Creation owns new image identities and durable binary copies; its caller commits all source and ownership metadata together. */
export class FileDocumentCreationContent {
  private readonly directories: DocumentAssetDirectories;
  private readonly decoder = new DocumentImageDecoder();
  constructor(root: string) {
    this.directories = new DocumentAssetDirectories(root);
  }
  async prepare(project: ProjectContentProject, documentId: string, input: PreparedDocumentCreation) {
    if (
      input.images.length > 64 ||
      input.images.reduce((sum, image) => sum + image.bytes.byteLength, 0) > 48 * 1024 * 1024
    )
      throw new DocumentError("assetTooLarge", 413);
    const body = richDocumentInput(input.body).body,
      images = input.images.map((image) => ({ ...image, bytes: imageUploadBytes(image.bytes) })),
      ids = new Map<string, string>();
    for (const image of images) {
      if (ids.has(image.id)) throw new DocumentError("invalidImage");
      ids.set(image.id, randomUUID());
    }
    const visit = (node: RichTextNode) => {
      if (node.type === "image") {
        const id = ids.get(richImageId(node.attrs?.src));
        if (!id) throw new DocumentError("invalidImage");
        node.attrs = { ...node.attrs, src: "/api/document-assets/content?id=" + id };
      }
      node.content?.forEach(visit);
    };
    visit(body.document);
    const source = richDocumentInput(body),
      assets: DocumentAsset[] = [];
    if (images.length) {
      const blobs = await this.directories.open(project.owned, true);
      for (const image of images) {
        const staged = await this.decoder.decode(image.name, image.bytes);
        await blobs.put(staged.digest, staged.bytes);
        const { bytes: _bytes, ...metadata } = staged;
        assets.push({ ...metadata, id: ids.get(image.id)!, documentId, alt: "", createdAt: Date.now() });
      }
    }
    return { source, assets, ...(input.copiedFrom ? { copiedFrom: structuredClone(input.copiedFrom) } : {}) };
  }
}
