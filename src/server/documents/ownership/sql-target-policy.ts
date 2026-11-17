import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import { createHash } from "node:crypto";
import { richBodyImageIds } from "../../../shared/documents/rich-body.js";
import { stableJson } from "../../../shared/stable-json.js";
import { projectRevisionSummary } from "../../project-content/document-history.js";
import { decodeProjectDocument, encodeProjectDocument } from "../../project-content/document-file.js";
import { DocumentError } from "../errors.js";
import { ownershipSQLTable, type OwnershipSQLBatch } from "./sql-batch.js";
import type { DocumentOwnershipInventory, DocumentOwnershipOriginals, DocumentOwnershipPlan } from "./contracts.js";
import { sqlOwnershipSnapshot, type SQLOwnershipSnapshot } from "./sql-snapshot.js";
import { SQLDocumentOwnershipSource } from "./sql-source.js";

export const comparableOwnershipRevision = (revision: DocumentDetail["revision"]) => ({
  ...revision,
  resources: revision.resources ?? [],
});
export async function sqlOwnershipTargetState(
  db: OwnershipSQLBatch,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  originals: DocumentOwnershipOriginals,
) {
  const state = await sqlOwnershipSnapshot(
    db,
    plan.to.projectId,
    inventory.nodes.map((node) => node.documentId),
  );
  if (state.space) {
    const queries = inventory.nodes.map((node) => {
      const previous = state.documents.find((row) => row.id === node.documentId),
        path = previous?.spaceId === state.space!.id ? previous.path : node.documentId + ".md";
      return {
        sql: `SELECT id FROM ${ownershipSQLTable(db, "documents")} WHERE spaceId=? AND ${db.mysql ? "pathHash" : "path"}=? AND id<>? ORDER BY id`,
        values: [state.space!.id, db.mysql ? createHash("sha256").update(path).digest("hex") : path, node.documentId],
      };
    });
    const rows = await db.read(queries);
    if (rows.some((records) => records.length)) throw new DocumentError("conflict", 409);
    state.checks.push(...queries.map((query, i) => ({ ...query, rows: rows[i]! })));
  }
  for (const current of state.documents) {
    const node = inventory.nodes.find((node) => node.documentId === current.id)!,
      marker = state.ownership.find(
        (row) => row.spaceId === current.spaceId && row.record.documentId === current.id,
      )?.record,
      liveSource =
        originals.relationalOrigin === db &&
        current.spaceId === node.document.spaceId &&
        stableJson(current) === stableJson(node.document) &&
        !state.trash.some((row) => row.documentId === current.id);
    if (liveSource) {
      if (marker && (marker.kind !== "active" || marker.to.projectId !== plan.from.projectId))
        throw new DocumentError("conflict", 409);
    } else if (
      !marker ||
      marker.kind !== "outgoing" ||
      marker.lineageId !== plan.lineages.find((row) => row.documentId === current.id)!.lineageId ||
      !state.trash.some((row) => row.documentId === current.id) ||
      state.tree.some((row) => row.documentId === current.id)
    )
      throw new DocumentError("conflict", 409);
    if (current.revision > node.document.revision) throw new DocumentError("conflict", 409);
    const existing = state.revisions.filter((row) => row.documentId === current.id);
    if (existing.length !== current.revision) throw new DocumentError("conflict", 409);
    const reader = new SQLDocumentOwnershipSource(
        db,
        () => {
          throw Error("Unexpected tree access");
        },
        async () => {
          throw Error("Unexpected image access");
        },
        async () => {},
      ),
      snapshot = { inventory, state };
    for (const row of existing) {
      const expected = inventory.revisions.find((item) => item.documentId === current.id && item.number === row.number);
      if (stableJson(row) !== stableJson(expected)) throw new DocumentError("conflict", 409);
      const [original, actual] = await Promise.all([
        originals.version(row.documentId, row.id),
        reader.version(snapshot, row.documentId, row.id),
      ]);
      if (
        stableJson(comparableOwnershipRevision(original.revision)) !==
        stableJson(comparableOwnershipRevision(actual.revision))
      )
        throw new DocumentError("conflict", 409);
    }
  }
  for (const asset of state.assets)
    if (stableJson(inventory.assets.find((row) => row.id === asset.id)) !== stableJson(asset))
      throw new DocumentError("conflict", 409);
  // Global primary keys must not borrow a revision or image belonging to an unrelated document.
  for (const [name, selected] of [
    ["document_revisions", inventory.revisions],
    ["document_assets", inventory.assets],
  ] as const)
    for (let offset = 0; offset < selected.length; offset += 250) {
      const ids = selected.slice(offset, offset + 250).map((row) => row.id),
        query = {
          sql: `SELECT id,documentId FROM ${ownershipSQLTable(db, name)} WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
          values: ids,
        },
        [rows] = await db.read([query]);
      for (const row of rows!)
        if (
          !selected.some((item) => item.id === row.id && item.documentId === row.documentId) ||
          !state.documents.some((item) => item.id === row.documentId)
        )
          throw new DocumentError("conflict", 409);
      state.checks.push({ ...query, rows: rows! });
    }
  return state;
}
export async function sqlOwnershipOriginals(
  inventory: DocumentOwnershipInventory,
  originals: DocumentOwnershipOriginals,
): Promise<DocumentDetail[]> {
  const versions: DocumentDetail[] = [];
  for (const row of inventory.revisions) {
    const detail = await originals.version(row.documentId, row.id);
    if (stableJson(projectRevisionSummary(detail.revision)) !== stableJson(row))
      throw new DocumentError("conflict", 409);
    for (const id of detail.revision.body ? richBodyImageIds(detail.revision.body) : [])
      if (!inventory.assets.some((asset) => asset.id === id && asset.documentId === row.documentId))
        throw new DocumentError("invalidImage");
    for (const resource of detail.revision.resources ?? [])
      if (
        !inventory.assets.some(
          (asset) =>
            asset.id === resource.assetId && asset.documentId === row.documentId && asset.digest === resource.digest,
        )
      )
        throw new DocumentError("invalidImage");
    versions.push(decodeProjectDocument(encodeProjectDocument(detail)));
  }
  return versions;
}
export function sqlOwnershipTargetPlacements(
  state: SQLOwnershipSnapshot,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
) {
  if (
    !state.space ||
    state.version === null ||
    (plan.parentId !== null && !state.tree.some((row) => row.documentId === plan.parentId))
  )
    throw new DocumentError("conflict", 409);
  return inventory.nodes.map((node) => ({
    documentId: node.documentId,
    parentId: node.documentId === inventory.rootDocumentId ? plan.parentId : node.parentId,
    position:
      node.documentId === inventory.rootDocumentId
        ? state.tree.filter((row) => row.parentId === plan.parentId).length
        : node.position,
  }));
}
