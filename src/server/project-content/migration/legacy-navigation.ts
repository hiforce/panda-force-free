import type { DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import { validateDocumentTree } from "../../../shared/documents/navigation.js";
import { fileInteger, fileText } from "../codec-values.js";
import { ProjectContentError } from "../errors.js";
import { decodeNavigationOperation, type ProjectNavigationOperation } from "../navigation-operation-file.js";
import { projectContentId } from "../paths.js";
import { LegacyMetadataContext, legacyMetadataJson } from "./metadata-context.js";

export interface LegacyNavigationNode extends DocumentTreePlacement {
  spaceId: string;
}
export interface LegacyNavigationTombstone extends LegacyNavigationNode {
  operationId: string;
}
export interface LegacyNavigationMetadata {
  schema: number;
  versions: { spaceId: string; version: number }[];
  nodes: LegacyNavigationNode[];
  tombstones: LegacyNavigationTombstone[];
  origins: { spaceId: string; path: string; documentId: string }[];
  operations: ProjectNavigationOperation[];
}
export function readLegacyNavigation(
  context: LegacyMetadataContext,
  spaces: ReadonlySet<string>,
): LegacyNavigationMetadata {
  const result: LegacyNavigationMetadata = {
    schema: 0,
    versions: [],
    nodes: [],
    tombstones: [],
    origins: [],
    operations: [],
  };
  if (!context.tables.has("document_navigation_schema")) return result;
  const schema =
    context.rows<{ version: number }>("SELECT version FROM document_navigation_schema WHERE id=1")[0]?.version ?? 0;
  if (!Number.isSafeInteger(schema) || schema < 0 || schema > 2) throw new ProjectContentError("unsupportedSchema");
  if (schema === 0) return result;
  result.schema = schema;
  context.requireTables([
    "document_tree_versions",
    "document_tree_nodes",
    "document_tree_operations",
    "document_tree_trash",
    ...(schema >= 2 ? ["document_tree_folder_origins"] : []),
  ]);
  const ownedSpace = (id: string) => {
    projectContentId(id);
    if (!spaces.has(id)) throw new ProjectContentError("invalidFile");
    return id;
  };
  result.versions = context
    .rows<{ spaceId: string; version: number }>(
      "SELECT v.* FROM document_tree_versions v JOIN document_spaces s ON s.id=v.spaceId WHERE s.projectId=? ORDER BY v.spaceId",
      [context.projectId],
    )
    .map((row) => ({ spaceId: ownedSpace(row.spaceId), version: fileInteger(row.version) }));
  const node = (row: LegacyNavigationNode): LegacyNavigationNode => {
    context.requireDocument(row.documentId, row.spaceId);
    return {
      spaceId: ownedSpace(row.spaceId),
      documentId: projectContentId(row.documentId),
      parentId: row.parentId === null ? null : projectContentId(row.parentId),
      position: fileInteger(row.position),
    };
  };
  result.nodes = context
    .rows<LegacyNavigationNode>(
      "SELECT n.* FROM document_tree_nodes n JOIN document_spaces s ON s.id=n.spaceId WHERE s.projectId=? ORDER BY n.spaceId,n.documentId",
      [context.projectId],
    )
    .map(node);
  const versions = new Set(result.versions.map((row) => row.spaceId));
  for (const space of spaces) {
    const nodes = result.nodes.filter((row) => row.spaceId === space);
    if (nodes.length && !versions.has(space)) throw new ProjectContentError("invalidFile");
    try {
      validateDocumentTree(nodes);
    } catch {
      throw new ProjectContentError("invalidFile");
    }
  }
  const operations = context.rows<{
    id: string;
    spaceId: string;
    owner: string;
    request: string;
    documentId: string;
    createdAt: number;
    result: string | null;
  }>(
    "SELECT o.id,o.spaceId,o.owner,o.request,o.documentId,o.createdAt," +
      (schema >= 2 ? "o.result" : "NULL AS result") +
      " FROM document_tree_operations o JOIN document_spaces s ON s.id=o.spaceId WHERE s.projectId=? ORDER BY o.id",
    [context.projectId],
  );
  result.operations = operations.map((row) => {
    ownedSpace(row.spaceId);
    context.requireDocument(row.documentId, row.spaceId);
    const operation = decodeNavigationOperation({
      ...row,
      result: row.result === null ? null : legacyMetadataJson(row.result),
      ...(/^[a-f0-9]{64}$/.test(row.request) ? {} : { legacyRequest: true }),
    });
    for (const id of operation.result?.affectedDocumentIds ?? []) context.requireDocument(id, operation.spaceId);
    return operation;
  });
  const ops = new Map(result.operations.map((record) => [record.id, record]));
  const sql =
    schema >= 2
      ? "SELECT t.* FROM document_tree_trash t JOIN document_spaces s ON s.id=t.spaceId WHERE s.projectId=? ORDER BY t.documentId"
      : "SELECT t.documentId,n.spaceId,n.parentId,n.position,t.operationId FROM document_tree_trash t JOIN document_tree_nodes n ON n.documentId=t.documentId JOIN document_spaces s ON s.id=n.spaceId WHERE s.projectId=? ORDER BY t.documentId";
  result.tombstones = context.rows<LegacyNavigationTombstone>(sql, [context.projectId]).map((row) => {
    const record = { ...node(row), operationId: projectContentId(row.operationId) };
    if (ops.get(record.operationId)?.spaceId !== record.spaceId) throw new ProjectContentError("invalidFile");
    if (record.parentId !== null) context.requireDocument(record.parentId, record.spaceId);
    return record;
  });
  if (schema >= 2)
    result.origins = context
      .rows<{ spaceId: string; path: string; documentId: string }>(
        "SELECT o.* FROM document_tree_folder_origins o JOIN document_spaces s ON s.id=o.spaceId WHERE s.projectId=? ORDER BY o.spaceId,o.path",
        [context.projectId],
      )
      .map((row) => {
        const path = fileText(row.path, 2048);
        context.requireDocument(row.documentId, row.spaceId);
        ownedSpace(row.spaceId);
        if (path.includes("\\") || path.includes(":") || path.split("/").some((part) => !part || part.startsWith(".")))
          throw new ProjectContentError("invalidFile");
        return { ...row, path };
      });
  return result;
}
