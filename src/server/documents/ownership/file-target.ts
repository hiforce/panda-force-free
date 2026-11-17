import { stableJson } from "../../../shared/stable-json.js";
import { DocumentAssetDirectories } from "../files/asset-directories.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { readDocumentOwnership } from "../../project-content/ownership-file.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { DocumentError } from "../errors.js";
import { assertOwnershipPlan, ownershipRecord } from "./plan.js";
import type { DocumentOwnershipInventory, DocumentOwnershipOriginals, DocumentOwnershipPlan } from "./contracts.js";
import { importOwnershipDocument } from "./file-target-import.js";
import { activateOwnershipTarget, ownershipActivationReceipt } from "./file-target-tree.js";

/** The target keeps imported data unreadable until all versions and images verify and the source is actually removed. */
export class FileDocumentOwnershipTarget {
  private readonly directories: DocumentAssetDirectories;
  constructor(
    private readonly projects: DocumentFileProjects,
    assetRoot: string,
  ) {
    this.directories = new DocumentAssetDirectories(assetRoot);
  }
  receipt(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    assertOwnershipPlan(plan, inventory);
    return ownershipActivationReceipt(this.projects, plan, inventory);
  }
  async stage(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    source: DocumentOwnershipOriginals,
    assertSourceCurrent: () => Promise<void>,
  ) {
    plan = structuredClone(plan);
    inventory = structuredClone(inventory);
    assertOwnershipPlan(plan, inventory);
    const done = await this.receipt(plan, inventory);
    if (done) return done;
    await assertSourceCurrent();
    // Bytes can be staged without publishing a document or borrowing an unknown document identity.
    if (inventory.assets.length)
      await this.projects.initialize(plan.to.projectId, async (project) => {
        const blobs = await this.directories.open(project.owned, true);
        for (const asset of inventory.assets) {
          const original = await source.image(asset.id);
          if (stableJson(original.asset) !== stableJson(asset)) throw new DocumentError("conflict", 409);
          await this.projects.authorize(plan.to.projectId);
          await blobs.put(asset.digest, original.bytes);
        }
      });
    for (const node of inventory.nodes)
      await importOwnershipDocument(this.projects, plan, inventory, node.documentId, source, assertSourceCurrent);
    await this.verify(plan, inventory, source);
    return null;
  }
  async verify(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory, source: DocumentOwnershipOriginals) {
    assertOwnershipPlan(plan, inventory);
    const project = await this.projects.view(plan.to.projectId, async (project, view) => {
      for (const node of inventory.nodes) {
        const marker = await readDocumentOwnership(view, node.documentId),
          record = (await readProjectDocumentMetadata(view, node.documentId)).document;
        if (
          stableJson(marker) !== stableJson(ownershipRecord(plan, inventory, node.documentId, "incoming")) ||
          record.revision !== node.document.revision ||
          record.revisionId !== node.document.revisionId ||
          record.title !== node.document.title ||
          record.contentHash !== node.document.contentHash
        )
          throw new DocumentError("conflict", 409);
        const assets = await project.assets.listIn(view, node.documentId),
          expected = inventory.assets
            .filter((row) => row.documentId === node.documentId)
            .sort((a, b) => a.id.localeCompare(b.id, "en"));
        if (stableJson(assets.sort((a, b) => a.id.localeCompare(b.id, "en"))) !== stableJson(expected))
          throw new DocumentError("conflict", 409);
      }
      return project;
    });
    for (const row of inventory.revisions) {
      await this.projects.authorize(plan.to.projectId);
      const [actual, original] = await Promise.all([
        project.documents.revision(row.documentId, row.id),
        source.version(row.documentId, row.id),
      ]);
      if (stableJson(actual) !== stableJson(original.revision)) throw new DocumentError("conflict", 409);
    }
    if (inventory.assets.length) {
      const blobs = await this.directories.open(project.owned);
      for (const asset of inventory.assets) {
        await this.projects.authorize(plan.to.projectId);
        await blobs.read(asset.digest, asset.size);
      }
    }
    await this.projects.authorize(plan.to.projectId);
  }
  async activate(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    assertSourceRemoved: () => Promise<void>,
  ) {
    plan = structuredClone(plan);
    inventory = structuredClone(inventory);
    assertOwnershipPlan(plan, inventory);
    const done = await this.receipt(plan, inventory);
    if (done) return done;
    await assertSourceRemoved();
    return activateOwnershipTarget(this.projects, plan, inventory);
  }
}
