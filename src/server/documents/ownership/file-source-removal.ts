import { stableJson } from "../../../shared/stable-json.js";
import { liftRemovedNodes } from "../../../shared/documents/navigation-structure.js";
import type { DocumentTreeReceipt } from "../../../shared/documents/navigation.js";
import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import { ProjectContentPlan } from "../../project-content/plan-view.js";
import {
  readDocumentOwnership,
  encodeDocumentOwnership,
  projectDocumentOwnershipFile,
} from "../../project-content/ownership-file.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { readFileTree } from "../files/navigation/read.js";
import { DocumentError } from "../errors.js";
import { readFileOwnershipCurrent, comparableOwnershipCurrent } from "./file-source-current.js";
import type { FileOwnershipSnapshot } from "./file-source.js";
import { ownershipPhase, ownershipRecord, assertOwnershipPlan, fileOwnershipInventory } from "./plan.js";
import type { DocumentOwnershipInventory, DocumentOwnershipPlan } from "./contracts.js";

/** Source placement and its forwarding identity disappear together; ordinary restore cannot create an active duplicate. */
export class FileDocumentOwnershipRemoval {
  constructor(private readonly projects: DocumentFileProjects) {}
  async removed(transfer: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    assertOwnershipPlan(transfer, inventory);
    const project = await this.projects.ifPresent(transfer.from.projectId, async (owner) => owner);
    if (!project || !(await project.coordinator.plannedReceipt(ownershipPhase(transfer, "remove")))) return false;
    await this.assertRemoved(transfer, inventory);
    return true;
  }
  async remove(transfer: DocumentOwnershipPlan, snapshot: FileOwnershipSnapshot) {
    transfer = structuredClone(transfer);
    snapshot = structuredClone(snapshot);
    const inventory = fileOwnershipInventory(snapshot);
    assertOwnershipPlan(transfer, inventory);
    const command = ownershipPhase(transfer, "remove");
    await this.projects.write(transfer.from.projectId, (project) =>
      project.coordinator.plan(command, async (view) => {
        const current = await readFileOwnershipCurrent(
            project,
            view,
            transfer.from.projectId,
            inventory.rootDocumentId,
          ),
          { versions: _versions, ...original } = snapshot;
        if (stableJson(comparableOwnershipCurrent(current)) !== stableJson(comparableOwnershipCurrent(original)))
          throw new DocumentError("conflict", 409);
        const plan = new ProjectContentPlan(view),
          tree = await readFileTree(plan, transfer.from.projectId),
          state = tree.state;
        if (!state) throw new DocumentError("conflict", 409);
        const ids = new Set(inventory.nodes.map((node) => node.documentId)),
          operation: DocumentTreeReceipt = {
            id: command.operationId,
            documentId: inventory.rootDocumentId,
            affectedDocumentIds: [...ids],
            treeVersion: state.version + 1,
            restoredToRoot: false,
          };
        for (const id of ids)
          plan.apply([
            {
              path: projectDocumentOwnershipFile(id),
              content: encodeDocumentOwnership(ownershipRecord(transfer, inventory, id, "outgoing")),
            },
          ]);
        plan.apply(
          await project.navigation.prepare(
            plan,
            {
              ...state,
              version: operation.treeVersion,
              lastOperation: operation,
              nodes: liftRemovedNodes(state.nodes, ids),
              trash: [
                ...state.trash,
                ...inventory.nodes.map((node) => ({
                  documentId: node.documentId,
                  parentId: node.parentId,
                  position: node.position,
                  deletedAt: transfer.startedAt,
                  operationId: transfer.id,
                })),
              ],
            },
            state.version,
            command.operationId,
          ),
        );
        return { changes: plan.changes() };
      }),
    );
    await this.assertRemoved(transfer, inventory);
  }
  async assertRemoved(transfer: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    transfer = structuredClone(transfer);
    inventory = structuredClone(inventory);
    assertOwnershipPlan(transfer, inventory);
    await this.projects.view(transfer.from.projectId, async (project, view) => {
      const tree = await readFileTree(view, transfer.from.projectId),
        assets: DocumentAsset[] = [];
      for (const node of inventory.nodes) {
        const marker = await readDocumentOwnership(view, node.documentId),
          current = await readProjectDocumentMetadata(view, node.documentId);
        if (
          tree.tree.nodes.some((row) => row.documentId === node.documentId) ||
          !tree.state?.trash.some((row) => row.documentId === node.documentId && row.operationId === transfer.id) ||
          stableJson(marker) !== stableJson(ownershipRecord(transfer, inventory, node.documentId, "outgoing")) ||
          stableJson(current.document) !== stableJson(node.document)
        )
          throw new DocumentError("conflict", 409);
        assets.push(...(await project.assets.listIn(view, node.documentId)));
      }
      if (stableJson(assets.sort((a, b) => a.id.localeCompare(b.id, "en"))) !== stableJson(inventory.assets))
        throw new DocumentError("conflict", 409);
    });
  }
}
