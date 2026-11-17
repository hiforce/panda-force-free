import { stableJson } from "../../../shared/stable-json.js";
import { insertTreeNodes } from "../../../shared/documents/navigation-structure.js";
import type { DocumentTreeReceipt } from "../../../shared/documents/navigation.js";
import { ProjectContentPlan } from "../../project-content/plan-view.js";
import { decodeProjectNavigation } from "../../project-content/navigation-file.js";
import {
  readDocumentOwnership,
  encodeDocumentOwnership,
  projectDocumentOwnershipFile,
} from "../../project-content/ownership-file.js";
import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { readFileTree } from "../files/navigation/read.js";
import { DocumentError } from "../errors.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { ownershipPhase, ownershipRecord } from "./plan.js";
import type { DocumentOwnershipInventory, DocumentOwnershipPlan, DocumentOwnershipReceipt } from "./contracts.js";

export function ownershipActivationCommand(plan: DocumentOwnershipPlan) {
  return ownershipPhase(plan, "activate");
}
export async function ownershipActivationReceipt(
  projects: DocumentFileProjects,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
): Promise<DocumentOwnershipReceipt | null> {
  const project = await projects.ifPresent(plan.to.projectId, async (project) => project);
  if (!project) return null;
  const receipt = await project.coordinator.plannedReceipt(ownershipActivationCommand(plan));
  if (!receipt) return null;
  const bytes = await new ProjectGitSnapshots(project.owned).fileAt(receipt.commit, "tree.json"),
    state = bytes
      ? decodeProjectNavigation(bytes).spaces.find((row) => row.lastOperation?.id === receipt.operationId)
      : null,
    root = inventory.nodes.find((row) => row.documentId === inventory.rootDocumentId)!;
  if (!state || state.lastOperation?.documentId !== root.documentId) throw new DocumentError("sourceUnavailable", 503);
  return {
    operationId: plan.id,
    projectId: plan.to.projectId,
    documentId: root.documentId,
    revisionId: root.document.revisionId,
    revision: root.document.revision,
    treeVersion: state.version,
    manifestHash: plan.manifestHash,
  };
}
export async function activateOwnershipTarget(
  projects: DocumentFileProjects,
  transfer: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
) {
  const command = ownershipActivationCommand(transfer);
  await projects.write(transfer.to.projectId, (project) =>
    project.coordinator.plan(command, async (view) => {
      const plan = new ProjectContentPlan(view),
        tree = await readFileTree(plan, transfer.to.projectId),
        state = tree.state;
      if (
        !state ||
        !tree.space ||
        (transfer.parentId !== null && !state.nodes.some((row) => row.documentId === transfer.parentId))
      )
        throw new DocumentError("navigationConflict", 409);
      const ids = new Set(inventory.nodes.map((row) => row.documentId));
      for (const node of inventory.nodes) {
        const marker = await readDocumentOwnership(plan, node.documentId),
          current = (await readProjectDocumentMetadata(plan, node.documentId)).document;
        if (
          stableJson(marker) !== stableJson(ownershipRecord(transfer, inventory, node.documentId, "incoming")) ||
          state.nodes.some((row) => row.documentId === node.documentId) ||
          current.revisionId !== node.document.revisionId ||
          current.revision !== node.document.revision ||
          current.contentHash !== node.document.contentHash
        )
          throw new DocumentError("conflict", 409);
        plan.apply([
          {
            path: projectDocumentOwnershipFile(node.documentId),
            content: encodeDocumentOwnership(ownershipRecord(transfer, inventory, node.documentId, "active")),
          },
        ]);
      }
      const operation: DocumentTreeReceipt = {
          id: command.operationId,
          documentId: inventory.rootDocumentId,
          affectedDocumentIds: [...ids],
          treeVersion: state.version + 1,
          restoredToRoot: false,
        },
        nodes = inventory.nodes.map((node) => ({
          documentId: node.documentId,
          parentId: node.documentId === inventory.rootDocumentId ? transfer.parentId : node.parentId,
          position:
            node.documentId === inventory.rootDocumentId
              ? state.nodes.filter((row) => row.parentId === transfer.parentId).length
              : node.position,
        }));
      plan.apply(
        await project.navigation.prepare(
          plan,
          {
            ...state,
            version: operation.treeVersion,
            lastOperation: operation,
            nodes: insertTreeNodes(state.nodes, nodes),
            trash: state.trash.filter((row) => !ids.has(row.documentId)),
          },
          state.version,
          command.operationId,
        ),
      );
      return { changes: plan.changes() };
    }),
  );
  const receipt = await ownershipActivationReceipt(projects, transfer, inventory);
  if (!receipt) throw new DocumentError("sourceUnavailable", 503);
  return receipt;
}
