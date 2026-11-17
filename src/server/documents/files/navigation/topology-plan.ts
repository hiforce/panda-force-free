import {
  DOCUMENT_TREE_LIMITS,
  documentSubtree,
  moveDocumentTree,
  type DocumentTreeReceipt,
} from "../../../../shared/documents/navigation.js";
import { insertTreeNodes, liftRemovedNodes } from "../../../../shared/documents/navigation-structure.js";
import { planTreeRestore } from "../../../../shared/documents/navigation-restoration.js";
import type { ProjectNavigationState } from "../../../project-content/navigation-file.js";
import type { ProjectContentPlan } from "../../../project-content/plan-view.js";
import type { ProjectContentProject } from "../../../project-content/project.js";
import { DocumentError } from "../../errors.js";
import { navigationGuard } from "../../navigation/validation.js";
import type { FileTreeCommand } from "./commands.js";
import type { FileTreeSnapshot } from "./read.js";
import { emptyNavigation } from "./read.js";
import { prepareCreatedSource, prepareRenamedSource, type PrepareDocumentSource } from "./source-plan.js";
import { readDocumentOwnership } from "../../../project-content/ownership-file.js";

export async function planTreeAction(
  project: ProjectContentProject,
  plan: ProjectContentPlan,
  command: FileTreeCommand,
  snapshot: FileTreeSnapshot,
  prepare?: PrepareDocumentSource,
) {
  if (!snapshot.space) throw new DocumentError("notFound", 404);
  const base = snapshot.state ?? emptyNavigation(snapshot.space.id);
  let state: ProjectNavigationState = {
      ...base,
      nodes: base.nodes.map((node) => ({ ...node })),
      trash: base.trash.map((row) => ({ ...row })),
    },
    documentId: string,
    affectedDocumentIds: string[],
    restoredToRoot = false,
    message: string | undefined;
  if (command.kind === "create") {
    if (state.nodes.length >= DOCUMENT_TREE_LIMITS.documents) throw new DocumentError("tooManyDocuments", 409);
    if (command.parentId !== null && !state.nodes.some((node) => node.documentId === command.parentId))
      throw new DocumentError("notFound", 404);
    const created = await prepareCreatedSource(project, plan, command, state.spaceId, prepare);
    documentId = created.documentId;
    affectedDocumentIds = [documentId];
    message = created.message;
    state.nodes = navigationGuard(() =>
      insertTreeNodes(state.nodes, [
        {
          documentId,
          parentId: command.parentId,
          position: state.nodes.filter((node) => node.parentId === command.parentId).length,
        },
      ]),
    );
  } else {
    documentId = command.documentId;
    if (command.kind === "restore") {
      const ownership = await readDocumentOwnership(plan, documentId);
      if (ownership && ownership.kind !== "active") throw new DocumentError("notFound", 404);
      if (ownership && ownership.to.projectId !== command.projectId) throw new DocumentError("conflict", 409);
      const tombstone = state.trash.find((row) => row.documentId === documentId);
      if (!tombstone) throw new DocumentError("notFound", 404);
      const placements =
          tombstone.operationId === null
            ? []
            : state.trash
                .filter((row) => row.operationId === tombstone.operationId)
                .map((row) => ({ documentId: row.documentId, parentId: row.parentId, position: row.position! })),
        restored = navigationGuard(() => planTreeRestore(state.nodes, placements, documentId, command.toRoot)),
        selected = new Set(restored.selected);
      state.nodes = restored.next;
      state.trash = state.trash.filter((row) => !selected.has(row.documentId));
      affectedDocumentIds = restored.selected;
      restoredToRoot = restored.restoredToRoot;
    } else {
      const active = snapshot.tree.nodes.find((node) => node.documentId === documentId);
      if (!active) throw new DocumentError("notFound", 404);
      affectedDocumentIds = navigationGuard(() => documentSubtree(state.nodes, documentId));
      if (command.kind === "move")
        state.nodes = navigationGuard(() => moveDocumentTree(state.nodes, documentId, command.target));
      else if (command.kind === "rename") {
        message = await prepareRenamedSource(project, plan, command, snapshot);
        affectedDocumentIds = [documentId];
      } else {
        if (active.document.revision !== command.revision) throw new DocumentError("conflict", 409);
        const removed = new Set(affectedDocumentIds),
          deletedAt = Date.now();
        state.trash.push(
          ...state.nodes
            .filter((node) => removed.has(node.documentId))
            .map((node) => ({ ...node, deletedAt, operationId: command.id })),
        );
        state.nodes = navigationGuard(() => liftRemovedNodes(state.nodes, removed));
      }
    }
  }
  const operation: DocumentTreeReceipt = {
    id: command.id,
    documentId,
    affectedDocumentIds,
    treeVersion: snapshot.tree.version + 1,
    restoredToRoot,
  };
  state = { ...state, version: operation.treeVersion, lastOperation: operation };
  plan.apply(await project.navigation.prepare(plan, state, snapshot.state?.version ?? null, command.id));
  plan.apply(
    await project.navigationOperations.prepareMany(plan, [
      {
        id: command.id,
        spaceId: state.spaceId,
        owner: command.owner,
        request: command.request,
        documentId,
        createdAt: Date.now(),
        result: operation,
      },
    ]),
  );
  return message;
}
