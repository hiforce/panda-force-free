import { stableJson } from "../../../shared/stable-json.js";
import { createHash } from "node:crypto";
import type { DocumentTreePlacement, DocumentTreeReceipt } from "../../../shared/documents/navigation.js";
import { DocumentError } from "../errors.js";
import type { DocumentOwnershipInventory, DocumentOwnershipPlan, DocumentOwnershipReceipt } from "./contracts.js";
import { ownershipPhase } from "./plan.js";
import {
  ownershipSQLInsert,
  ownershipSQLTable,
  type OwnershipSQLBatch,
  type OwnershipSQLStatement,
} from "./sql-batch.js";

const ownershipRequestHash = (intent: string) => createHash("sha256").update(intent).digest("hex");

export async function sqlOwnershipReceipt(
  db: OwnershipSQLBatch,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  phase: "remove" | "activate",
) {
  const command = ownershipPhase(plan, phase),
    [rows] = await db.read([
      {
        sql: `SELECT o.*,s.projectId FROM ${ownershipSQLTable(db, "document_tree_operations")} o JOIN ${ownershipSQLTable(db, "document_spaces")} s ON s.id=o.spaceId WHERE o.id=?`,
        values: [command.operationId],
      },
    ]);
  const row = rows![0];
  if (!row) return null;
  if (
    row.owner !== plan.owner ||
    row.request !== ownershipRequestHash(command.intent) ||
    row.documentId !== inventory.rootDocumentId ||
    row.projectId !== (phase === "activate" ? plan.to : plan.from).projectId
  )
    throw new DocumentError("conflict", 409);
  let receipt: DocumentTreeReceipt;
  try {
    receipt = JSON.parse(String(row.result)) as DocumentTreeReceipt;
  } catch {
    throw new DocumentError("sourceUnavailable", 503);
  }
  if (
    receipt.id !== command.operationId ||
    receipt.documentId !== inventory.rootDocumentId ||
    !Number.isSafeInteger(receipt.treeVersion) ||
    receipt.treeVersion < 0 ||
    stableJson([...receipt.affectedDocumentIds].sort()) !==
      stableJson(inventory.nodes.map((node) => node.documentId).sort())
  )
    throw new DocumentError("sourceUnavailable", 503);
  const root = inventory.nodes.find((node) => node.documentId === inventory.rootDocumentId)!;
  const value: DocumentOwnershipReceipt = {
    operationId: plan.id,
    documentId: root.documentId,
    projectId: row.projectId as string,
    revisionId: root.document.revisionId,
    revision: root.document.revision,
    treeVersion: receipt.treeVersion,
    manifestHash: plan.manifestHash,
  };
  return value;
}
export function sqlOwnershipOperation(
  db: OwnershipSQLBatch,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  phase: "remove" | "activate",
  spaceId: string,
  version: number,
): OwnershipSQLStatement {
  const command = ownershipPhase(plan, phase),
    receipt: DocumentTreeReceipt = {
      id: command.operationId,
      documentId: inventory.rootDocumentId,
      affectedDocumentIds: inventory.nodes.map((row) => row.documentId),
      treeVersion: version,
      restoredToRoot: false,
    };
  return ownershipSQLInsert(db, "document_tree_operations", {
    id: command.operationId,
    spaceId,
    owner: plan.owner,
    request: ownershipRequestHash(command.intent),
    documentId: inventory.rootDocumentId,
    createdAt: plan.startedAt,
    result: stableJson(receipt),
  });
}
export function sqlOwnershipTree(
  db: OwnershipSQLBatch,
  spaceId: string,
  nodes: DocumentTreePlacement[],
  version: number,
): OwnershipSQLStatement[] {
  // Parent-before-child insertion also supports installations with immediate foreign-key checks.
  const pending = [...nodes],
    ordered: DocumentTreePlacement[] = [],
    known = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((row) => row.parentId === null || known.has(row.parentId));
    if (index < 0) throw new DocumentError("invalidInput");
    const node = pending.splice(index, 1)[0]!;
    ordered.push(node);
    known.add(node.documentId);
  }
  return [
    { sql: `DELETE FROM ${ownershipSQLTable(db, "document_tree_nodes")} WHERE spaceId=?`, values: [spaceId] },
    ...ordered.map((node) => ownershipSQLInsert(db, "document_tree_nodes", { ...node, spaceId })),
    {
      sql: `UPDATE ${ownershipSQLTable(db, "document_tree_versions")} SET version=? WHERE spaceId=?`,
      values: [version, spaceId],
    },
  ];
}
