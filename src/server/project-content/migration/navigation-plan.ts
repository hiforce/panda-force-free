import type { DocumentDetail, DocumentRecord } from "../../../shared/documents/contracts.js";
import type { DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import { insertTreeNodes, liftRemovedNodes } from "../../../shared/documents/navigation-structure.js";
import {
  encodeProjectNavigation,
  type ProjectNavigationFile,
  type ProjectNavigationState,
} from "../navigation-file.js";
import type { ProjectNavigationOperation } from "../navigation-operation-file.js";
import type { LegacyProjectMetadata } from "./legacy-metadata.js";
import { legacyDirectoryDocument } from "./directory-document.js";
import { planLegacyTrash } from "./navigation-trash.js";
import { ProjectContentError } from "../errors.js";

export interface LegacyNavigationPlan {
  file: ProjectNavigationFile;
  generated: DocumentDetail[];
  operations: ProjectNavigationOperation[];
}
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const placement = ({ documentId, parentId, position }: DocumentTreePlacement): DocumentTreePlacement => ({
  documentId,
  parentId,
  position,
});

/** Existing trees preserve ordering; spaces without a tree deterministically convert paths to editable directory documents. */
export function planLegacyNavigation(
  metadata: LegacyProjectMetadata,
  input: readonly DocumentRecord[],
): LegacyNavigationPlan {
  const generated: DocumentDetail[] = [],
    operations = metadata.navigation.operations.map((row) => structuredClone(row)),
    known = new Set(input.map((record) => record.id)),
    deleted = new Set(metadata.trash.map((row) => row.documentId)),
    file: ProjectNavigationFile = { schema: 1, projectId: metadata.projectId, spaces: [] };
  for (const { space } of metadata.spaces) {
    const originals = input.filter((record) => record.spaceId === space.id),
      version = metadata.navigation.versions.find((row) => row.spaceId === space.id)?.version,
      origins = new Map(
        metadata.navigation.origins.filter((row) => row.spaceId === space.id).map((row) => [row.path, row.documentId]),
      ),
      oldNodes = metadata.navigation.nodes.filter((row) => row.spaceId === space.id).map(placement);
    let nodes: DocumentTreePlacement[] = [...oldNodes];
    if (version === undefined) {
      if (oldNodes.length || origins.size) throw new ProjectContentError("invalidFile");
      const paths = new Set<string>(),
        counts = new Map<string | null, number>();
      for (const path of [
        ...metadata.folders.filter((row) => row.spaceId === space.id).map((row) => row.path),
        ...originals.filter((row) => !deleted.has(row.id)).map((row) => parentPath(row.path)),
      ]) {
        const parts = path.split("/").filter(Boolean);
        parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
      }
      const append = (documentId: string, parentId: string | null) => {
        const position = counts.get(parentId) ?? 0;
        counts.set(parentId, position + 1);
        nodes.push({ documentId, parentId, position });
      };
      for (const path of [...paths].sort(
        (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"),
      )) {
        const detail = legacyDirectoryDocument(
            space,
            path,
            metadata.folders.find((row) => row.spaceId === space.id && row.path === path),
          ),
          id = detail.document.id;
        if (known.has(id) || originals.some((row) => row.path === detail.document.path))
          throw new ProjectContentError("conflict");
        known.add(id);
        generated.push(detail);
        origins.set(path, id);
        append(id, origins.get(parentPath(path)) ?? null);
      }
      for (const document of originals
        .filter((row) => !deleted.has(row.id))
        .sort((a, b) => a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id, "en")))
        append(document.id, origins.get(parentPath(document.path)) ?? null);
    } else {
      const removed = new Set(oldNodes.filter((row) => deleted.has(row.documentId)).map((row) => row.documentId));
      if (removed.size) nodes = liftRemovedNodes(oldNodes, removed);
      const active = new Set(nodes.map((row) => row.documentId)),
        pending = originals.filter((row) => !active.has(row.id) && !deleted.has(row.id)),
        available = new Set([...active, ...pending.map((row) => row.id)]),
        counts = new Map<string | null, number>();
      for (const node of nodes) counts.set(node.parentId, Math.max(counts.get(node.parentId) ?? 0, node.position + 1));
      const additions = pending.map((document) => {
        const tombstone = metadata.navigation.tombstones.find((row) => row.documentId === document.id),
          candidate = tombstone ? tombstone.parentId : origins.get(parentPath(document.path)),
          parentId = candidate && available.has(candidate) ? candidate : null,
          position = tombstone?.position ?? counts.get(parentId) ?? 0;
        counts.set(parentId, Math.max(counts.get(parentId) ?? 0, position + 1));
        return { documentId: document.id, parentId, position };
      });
      if (additions.length) nodes = insertTreeNodes(nodes, additions);
    }
    const changed =
        version !== undefined &&
        (oldNodes.some((row) => deleted.has(row.documentId)) ||
          nodes.some((row) => !oldNodes.some((old) => old.documentId === row.documentId))),
      nextVersion = (version ?? (nodes.length ? 1 : 0)) + (changed ? 1 : 0),
      trash = planLegacyTrash(metadata, space.id, nextVersion, originals, oldNodes);
    operations.push(...trash.operations);
    const state: ProjectNavigationState = {
        spaceId: space.id,
        version: nextVersion,
        nodes,
        trash: trash.trash,
        origins: [...origins].map(([path, documentId]) => ({ path, documentId })),
        lastOperation: null,
      },
      receipts = operations.filter((row) => row.spaceId === space.id && row.result?.treeVersion === nextVersion);
    if (receipts.length === 1) state.lastOperation = receipts[0]!.result;
    file.spaces.push(state);
  }
  encodeProjectNavigation(file);
  return { file, generated, operations };
}
