import { stableJson } from "../../../shared/stable-json.js";
import { liftRemovedNodes } from "../../../shared/documents/navigation-structure.js";
import { DocumentError } from "../errors.js";
import type { DocumentOwnershipInventory, DocumentOwnershipPlan } from "./contracts.js";
import { ownershipRecordText } from "./record.js";
import { assertOwnershipPlan, ownershipPhase, ownershipRecord } from "./plan.js";
import {
  ownershipSQLInsert,
  ownershipSQLTable,
  type OwnershipSQLBatch,
  type OwnershipSQLStatement,
} from "./sql-batch.js";
import { sqlOwnershipSnapshot } from "./sql-snapshot.js";
import type { SQLDocumentOwnershipSnapshot } from "./sql-source.js";
import { sqlOwnershipOperation, sqlOwnershipReceipt, sqlOwnershipTree } from "./sql-operations.js";

export class SQLDocumentOwnershipRemoval {
  constructor(
    private readonly db: OwnershipSQLBatch,
    private readonly authorize: (project: string) => void | Promise<void>,
  ) {}
  async removed(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    assertOwnershipPlan(plan, inventory);
    await this.authorize(plan.from.projectId);
    if (!(await sqlOwnershipReceipt(this.db, plan, inventory, "remove"))) return false;
    await this.assertRemoved(plan, inventory);
    return true;
  }
  async remove(plan: DocumentOwnershipPlan, snapshot: SQLDocumentOwnershipSnapshot) {
    const inventory = snapshot.inventory;
    assertOwnershipPlan(plan, inventory);
    await this.authorize(plan.from.projectId);
    const current = await sqlOwnershipSnapshot(
      this.db,
      plan.from.projectId,
      inventory.nodes.map((row) => row.documentId),
    );
    if (stableJson(current) !== stableJson(snapshot.state) || !current.space || current.version === null)
      throw new DocumentError("conflict", 409);
    const spaceId = current.space.id,
      ids = new Set(inventory.nodes.map((row) => row.documentId)),
      changes: OwnershipSQLStatement[] = [
        sqlOwnershipOperation(this.db, plan, inventory, "remove", spaceId, current.version + 1),
      ];
    for (const node of inventory.nodes) {
      changes.push(
        {
          sql: `DELETE FROM ${ownershipSQLTable(this.db, "document_ownership_records")} WHERE spaceId=? AND documentId=?`,
          values: [spaceId, node.documentId],
        },
        ownershipSQLInsert(this.db, "document_ownership_records", {
          spaceId,
          documentId: node.documentId,
          record: ownershipRecordText(ownershipRecord(plan, inventory, node.documentId, "outgoing")),
        }),
        ownershipSQLInsert(this.db, "document_trash", { documentId: node.documentId, deletedAt: plan.startedAt }),
        {
          sql: `DELETE FROM ${ownershipSQLTable(this.db, "document_tree_trash")} WHERE documentId=?`,
          values: [node.documentId],
        },
        ownershipSQLInsert(this.db, "document_tree_trash", {
          spaceId,
          documentId: node.documentId,
          parentId: node.parentId,
          position: node.position,
          operationId: ownershipPhase(plan, "remove").operationId,
        }),
      );
    }
    changes.push(...sqlOwnershipTree(this.db, spaceId, liftRemovedNodes(current.tree, ids), current.version + 1));
    await this.authorize(plan.from.projectId);
    await this.db.commit(current.checks, changes);
    await this.assertRemoved(plan, inventory);
  }
  async assertRemoved(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    await this.authorize(plan.from.projectId);
    const state = await sqlOwnershipSnapshot(
      this.db,
      plan.from.projectId,
      inventory.nodes.map((row) => row.documentId),
    );
    if (!state.space) throw new DocumentError("notFound", 404);
    for (const node of inventory.nodes)
      if (
        state.tree.some((row) => row.documentId === node.documentId) ||
        !state.trash.some((row) => row.documentId === node.documentId) ||
        !state.tombstones.some(
          (row) => row.documentId === node.documentId && row.operationId === ownershipPhase(plan, "remove").operationId,
        ) ||
        stableJson(state.documents.find((row) => row.id === node.documentId)) !== stableJson(node.document) ||
        stableJson(
          state.ownership.find((row) => row.spaceId === state.space!.id && row.record.documentId === node.documentId)
            ?.record,
        ) !== stableJson(ownershipRecord(plan, inventory, node.documentId, "outgoing"))
      )
        throw new DocumentError("conflict", 409);
    if (stableJson(state.assets) !== stableJson(inventory.assets)) throw new DocumentError("conflict", 409);
    await this.authorize(plan.from.projectId);
  }
}
