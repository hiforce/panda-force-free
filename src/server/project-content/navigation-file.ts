import {
  DOCUMENT_TREE_LIMITS,
  validateDocumentTree,
  type DocumentTreePlacement,
  type DocumentTreeReceipt,
} from "../../shared/documents/navigation.js";
import { fileInteger, fileRecord, fileText } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { projectContentId } from "./paths.js";

export interface ProjectNavigationTrash {
  documentId: string;
  deletedAt: number;
  parentId: string | null;
  position: number | null;
  operationId: string | null;
}
export interface ProjectNavigationState {
  spaceId: string;
  version: number;
  nodes: DocumentTreePlacement[];
  trash: ProjectNavigationTrash[];
  origins: { path: string; documentId: string }[];
  lastOperation: DocumentTreeReceipt | null;
}
export interface ProjectNavigationFile {
  schema: 1;
  projectId: string;
  spaces: ProjectNavigationState[];
}
const array = (value: unknown, limit: number = PROJECT_CONTENT_LIMITS.files): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw new ProjectContentError("invalidFile");
  return value;
};
function placement(value: unknown): DocumentTreePlacement {
  const v = fileRecord(value, ["documentId", "parentId", "position"]);
  return {
    documentId: projectContentId(v.documentId),
    parentId: v.parentId === null ? null : projectContentId(v.parentId),
    position: fileInteger(v.position),
  };
}
function topology(nodes: DocumentTreePlacement[]) {
  try {
    validateDocumentTree(nodes);
  } catch {
    throw new ProjectContentError("invalidFile");
  }
}
export function decodeNavigationReceipt(value: unknown, version?: number): DocumentTreeReceipt | null {
  if (value === null) return null;
  const v = fileRecord(value, ["id", "documentId", "affectedDocumentIds", "treeVersion", "restoredToRoot"]),
    ids = array(v.affectedDocumentIds, DOCUMENT_TREE_LIMITS.documents).map(projectContentId),
    id = projectContentId(v.documentId),
    treeVersion = fileInteger(v.treeVersion);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !ids.includes(id) ||
    (version !== undefined && treeVersion !== version) ||
    typeof v.restoredToRoot !== "boolean"
  )
    throw new ProjectContentError("invalidFile");
  return {
    id: projectContentId(v.id),
    documentId: id,
    affectedDocumentIds: ids,
    treeVersion,
    restoredToRoot: v.restoredToRoot,
  };
}
export function decodeNavigationState(value: unknown): ProjectNavigationState {
  const v = fileRecord(value, ["spaceId", "version", "nodes", "trash", "origins", "lastOperation"]),
    version = fileInteger(v.version),
    nodes = array(v.nodes, DOCUMENT_TREE_LIMITS.documents).map(placement),
    ids = new Set(nodes.map((node) => node.documentId));
  topology(nodes);
  const groups = new Map<string, DocumentTreePlacement[]>();
  const trash = array(v.trash).map((value): ProjectNavigationTrash => {
    const t = fileRecord(value, ["documentId", "deletedAt", "parentId", "position", "operationId"]),
      id = projectContentId(t.documentId),
      parentId = t.parentId === null ? null : projectContentId(t.parentId),
      position = t.position === null ? null : fileInteger(t.position),
      operationId = t.operationId === null ? null : projectContentId(t.operationId);
    if (ids.has(id) || (position === null) !== (operationId === null) || (position === null && parentId !== null))
      throw new ProjectContentError("invalidFile");
    ids.add(id);
    if (operationId !== null) {
      const group = groups.get(operationId) || [];
      group.push({ documentId: id, parentId, position: position! });
      groups.set(operationId, group);
    }
    return { documentId: id, deletedAt: fileInteger(t.deletedAt), parentId, position, operationId };
  });
  for (const group of groups.values()) {
    const members = new Set(group.map((node) => node.documentId));
    topology(
      group.map((node) => ({
        ...node,
        parentId: node.parentId !== null && members.has(node.parentId) ? node.parentId : null,
      })),
    );
  }
  const paths = new Set<string>();
  const origins = array(v.origins).map((value) => {
    const o = fileRecord(value, ["path", "documentId"]),
      path = fileText(o.path, 2048);
    if (
      paths.has(path) ||
      path.includes("\\") ||
      path.includes(":") ||
      path.split("/").some((part) => !part || part.startsWith("."))
    )
      throw new ProjectContentError("invalidFile");
    paths.add(path);
    return { path, documentId: projectContentId(o.documentId) };
  });
  return {
    spaceId: projectContentId(v.spaceId),
    version,
    nodes,
    trash,
    origins,
    lastOperation: decodeNavigationReceipt(v.lastOperation, version),
  };
}
function validate(value: unknown): ProjectNavigationFile {
  const v = fileRecord(value, ["schema", "projectId", "spaces"]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const spaces = array(v.spaces).map(decodeNavigationState),
    ids = new Set<string>(),
    documents = new Set<string>();
  for (const state of spaces) {
    if (ids.has(state.spaceId)) throw new ProjectContentError("invalidFile");
    ids.add(state.spaceId);
    for (const node of [...state.nodes, ...state.trash]) {
      if (documents.has(node.documentId)) throw new ProjectContentError("invalidFile");
      documents.add(node.documentId);
    }
  }
  return { schema: 1, projectId: projectContentId(v.projectId), spaces };
}
export const encodeProjectNavigation = (value: ProjectNavigationFile) => encodeContentJson(value, validate);
export const decodeProjectNavigation = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);
