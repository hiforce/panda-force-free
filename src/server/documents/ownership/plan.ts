import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { DOCUMENT_TREE_LIMITS, validateDocumentTree } from "../../../shared/documents/navigation.js";
import type { DocumentOwnershipRecord, DocumentOwnershipScope } from "../../../shared/documents/ownership.js";
import { documentOwnershipScope, encodeDocumentOwnership } from "../../project-content/ownership-file.js";
import { projectContentId } from "../../project-content/paths.js";
import { documentAuthor } from "../files/commands.js";
import { DocumentError } from "../errors.js";
import type { FileOwnershipSnapshot } from "./file-source.js";
import type { DocumentOwnershipInventory, DocumentOwnershipPlan } from "./contracts.js";

const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const uuid = (value: string) => {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new DocumentError("invalidInput");
  return value;
};
const uuidHash = (value: unknown) => {
  const hash = digest(value);
  return (
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-5" +
    hash.slice(13, 16) +
    "-a" +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32)
  );
};
export const ownershipPhase = (plan: DocumentOwnershipPlan, phase: string, documentId = "", revisionId = "") => ({
  operationId: "ownership-" + phase + "-" + digest([plan.id, documentId, revisionId]),
  author: documentAuthor(plan.owner),
  message: "Apply document ownership transfer",
  intent: stableJson({ schema: 1, transfer: plan.id, manifestHash: plan.manifestHash, phase, documentId, revisionId }),
});
export function fileOwnershipInventory(snapshot: FileOwnershipSnapshot): DocumentOwnershipInventory {
  const { projectId, rootDocumentId, nodes, assets, ownership } = snapshot;
  return structuredClone({
    projectId,
    rootDocumentId,
    nodes,
    assets,
    ownership,
    revisions: snapshot.versions.map((row) => row.revision),
  });
}
function manifest(plan: Omit<DocumentOwnershipPlan, "manifestHash">, inventory: DocumentOwnershipInventory) {
  return digest({ plan, inventory });
}
export function freezeOwnershipPlan(
  owner: string,
  id: string,
  from: DocumentOwnershipScope,
  to: DocumentOwnershipScope,
  parentId: string | null,
  inventory: DocumentOwnershipInventory,
  startedAt = Date.now(),
): DocumentOwnershipPlan {
  const lineages = inventory.nodes
    .map((node) => ({
      documentId: node.documentId,
      lineageId:
        inventory.ownership.find((row) => row.documentId === node.documentId)?.lineageId ??
        uuidHash({
          from,
          documentId: node.documentId,
          original: inventory.revisions.find((row) => row.documentId === node.documentId && row.number === 1)?.id,
        }),
    }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId, "en"));
  const value: Omit<DocumentOwnershipPlan, "manifestHash"> = {
      schema: 1,
      id: uuid(id),
      owner,
      from: documentOwnershipScope(from),
      to: documentOwnershipScope(to),
      parentId,
      startedAt,
      lineages,
    },
    plan = { ...value, manifestHash: manifest(value, inventory) };
  assertOwnershipPlan(plan, inventory);
  return structuredClone(plan);
}
export function assertOwnershipPlan(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
  const { manifestHash, ...value } = plan;
  uuid(plan.id);
  documentAuthor(plan.owner);
  const from = documentOwnershipScope(plan.from),
    to = documentOwnershipScope(plan.to),
    ids = new Set(inventory.nodes.map((node) => projectContentId(node.documentId)));
  if (
    plan.schema !== 1 ||
    stableJson(from) === stableJson(to) ||
    inventory.projectId !== from.projectId ||
    !ids.has(inventory.rootDocumentId) ||
    inventory.nodes.length > DOCUMENT_TREE_LIMITS.documents ||
    ids.size !== inventory.nodes.length ||
    !Number.isSafeInteger(plan.startedAt) ||
    plan.startedAt < 0 ||
    manifestHash !== manifest(value, inventory)
  )
    throw new DocumentError("invalidInput");
  if (plan.parentId !== null) projectContentId(plan.parentId);
  validateDocumentTree(
    inventory.nodes.map((node) => ({
      ...node,
      parentId: node.documentId === inventory.rootDocumentId ? null : node.parentId,
    })),
  );
  if (plan.lineages.length !== ids.size || new Set(plan.lineages.map((row) => row.documentId)).size !== ids.size)
    throw new DocumentError("invalidInput");
  for (const row of plan.lineages) {
    if (!ids.has(row.documentId)) throw new DocumentError("invalidInput");
    uuid(row.lineageId);
  }
  if (
    new Set(inventory.assets.map((row) => row.id)).size !== inventory.assets.length ||
    inventory.assets.some((row) => !ids.has(row.documentId))
  )
    throw new DocumentError("invalidInput");
  const revisions = new Set<string>();
  for (const node of inventory.nodes) {
    const rows = inventory.revisions
      .filter((row) => row.documentId === node.documentId)
      .sort((a, b) => a.number - b.number);
    if (
      rows.length !== node.document.revision ||
      node.document.id !== node.documentId ||
      rows.at(-1)?.id !== node.document.revisionId ||
      rows.at(-1)?.contentHash !== node.document.contentHash ||
      rows.at(-1)?.title !== node.document.title ||
      rows.at(-1)?.locale !== node.document.locale
    )
      throw new DocumentError("invalidInput");
    for (const [index, row] of rows.entries()) {
      if (row.number !== index + 1 || revisions.has(row.id)) throw new DocumentError("invalidInput");
      revisions.add(row.id);
    }
  }
  if (revisions.size !== inventory.revisions.length) throw new DocumentError("invalidInput");
}
export function ownershipRecord(
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  documentId: string,
  kind: DocumentOwnershipRecord["kind"],
): DocumentOwnershipRecord {
  const lineage = plan.lineages.find((row) => row.documentId === documentId);
  if (!lineage) throw new DocumentError("invalidInput");
  const record: DocumentOwnershipRecord = {
    schema: 1,
    documentId,
    lineageId: lineage.lineageId,
    operationId: plan.id,
    rootDocumentId: inventory.rootDocumentId,
    manifestHash: plan.manifestHash,
    kind,
    from: plan.from,
    to: plan.to,
  };
  encodeDocumentOwnership(record);
  return record;
}
