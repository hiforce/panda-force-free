import { stableJson } from "../../../shared/stable-json.js";
import { ProjectContentPlan } from "../../project-content/plan-view.js";
import { revisionCommitMessage } from "../../project-content/document-history.js";
import { assertCheckpointContent } from "../../project-content/drafts/checkpoint-policy.js";
import { projectDocumentFile } from "../../project-content/paths.js";
import {
  readDocumentOwnership,
  encodeDocumentOwnership,
  projectDocumentOwnershipFile,
} from "../../project-content/ownership-file.js";
import { readFileTree, emptyNavigation } from "../files/navigation/read.js";
import { prepareTreeLibrary } from "../files/navigation/source-plan.js";
import { fileTreeCommand } from "../files/navigation/commands.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { DocumentError } from "../errors.js";
import { ownershipPhase, ownershipRecord } from "./plan.js";
import { ownershipTargetDetail, ownershipTargetPrefix } from "./file-target-policy.js";
import type { DocumentOwnershipInventory, DocumentOwnershipOriginals, DocumentOwnershipPlan } from "./contracts.js";

/** Every newly imported original is hidden in the same commit that establishes its ownership. */
export async function importOwnershipDocument(
  projects: DocumentFileProjects,
  transfer: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  documentId: string,
  source: DocumentOwnershipOriginals,
  assertSourceCurrent: () => Promise<void>,
) {
  const node = inventory.nodes.find((row) => row.documentId === documentId)!,
    prefix = await ownershipTargetPrefix(projects, transfer, inventory, documentId, source),
    first = inventory.revisions.find((row) => row.documentId === documentId && row.number === 1)!,
    original = prefix ? null : await source.version(documentId, first.id),
    command = ownershipPhase(transfer, "reserve", documentId);
  await assertSourceCurrent();
  await projects.initialize(transfer.to.projectId, (project) =>
    project.coordinator.plan(command, async (view) => {
      const plan = new ProjectContentPlan(view);
      let tree = await readFileTree(plan, transfer.to.projectId);
      if (!tree.space) {
        const seed = fileTreeCommand("create", transfer.owner, {
          id: transfer.id,
          projectId: transfer.to.projectId,
          treeVersion: 0,
          parentId: null,
          title: "Document",
          locale: node.document.locale,
        });
        if (seed.kind !== "create") throw new DocumentError("invalidInput");
        await prepareTreeLibrary(project, plan, seed);
        tree = await readFileTree(plan, transfer.to.projectId);
      }
      if (
        !tree.space ||
        view.version(projectDocumentFile(documentId)) !== (prefix?.blob ?? null) ||
        stableJson(await readDocumentOwnership(view, documentId)) !== stableJson(prefix?.marker ?? null)
      )
        throw new DocumentError("conflict", 409);
      const state = tree.state ?? emptyNavigation(tree.space.id);
      let message: string | undefined;
      if (original) {
        const detail = ownershipTargetDetail(original, inventory, documentId, tree.space.id, documentId + ".md");
        plan.apply(await project.documents.prepare(plan, detail, null));
        message = revisionCommitMessage(detail.revision);
      }
      plan.apply(
        await project.assets.prepareMany(
          plan,
          inventory.assets.filter((row) => row.documentId === documentId),
        ),
      );
      if (original)
        await assertCheckpointContent(plan, transfer.to.projectId, documentId, tree.space.id, {
          title: original.revision.title,
          locale: original.revision.locale,
          content: original.revision.content,
          body: original.revision.body,
          resources: original.revision.resources ?? [],
        });
      plan.apply([
        {
          path: projectDocumentOwnershipFile(documentId),
          content: encodeDocumentOwnership(ownershipRecord(transfer, inventory, documentId, "incoming")),
        },
      ]);
      const operation = {
        id: command.operationId,
        documentId,
        affectedDocumentIds: [documentId],
        treeVersion: state.version + 1,
        restoredToRoot: false,
      };
      plan.apply(
        await project.navigation.prepare(
          plan,
          {
            ...state,
            version: operation.treeVersion,
            lastOperation: operation,
            trash: [
              ...state.trash.filter((row) => row.documentId !== documentId),
              {
                documentId,
                parentId: node.documentId === inventory.rootDocumentId ? null : node.parentId,
                position: node.position,
                deletedAt: transfer.startedAt,
                operationId: transfer.id,
              },
            ],
          },
          tree.state?.version ?? null,
          command.operationId,
        ),
      );
      return { changes: plan.changes(), ...(message ? { message } : {}) };
    }),
  );
  const target = await projects.view(transfer.to.projectId, async (project, view) => {
    const tree = await readFileTree(view, transfer.to.projectId);
    if (!tree.space) throw new DocumentError("sourceUnavailable", 503);
    return { project, spaceId: tree.space.id };
  });
  for (const row of inventory.revisions
    .filter((row) => row.documentId === documentId && row.number > (prefix?.document.revision ?? 1))
    .sort((a, b) => a.number - b.number)) {
    const original = await source.version(documentId, row.id),
      detail = ownershipTargetDetail(
        original,
        inventory,
        documentId,
        target.spaceId,
        prefix?.document.path ?? documentId + ".md",
      ),
      phase = ownershipPhase(transfer, "revision", documentId, row.id);
    await assertSourceCurrent();
    await projects.write(transfer.to.projectId, (project) =>
      project.coordinator.plan({ ...phase, message: revisionCommitMessage(detail.revision) }, async (view) => {
        if (
          stableJson(await readDocumentOwnership(view, documentId)) !==
          stableJson(ownershipRecord(transfer, inventory, documentId, "incoming"))
        )
          throw new DocumentError("conflict", 409);
        const plan = new ProjectContentPlan(view);
        plan.apply(await project.documents.prepare(plan, detail, row.number - 1));
        await assertCheckpointContent(plan, transfer.to.projectId, documentId, target.spaceId, {
          title: detail.revision.title,
          locale: detail.revision.locale,
          content: detail.revision.content,
          body: detail.revision.body,
          resources: detail.revision.resources ?? [],
        });
        return { changes: plan.changes() };
      }),
    );
  }
}
