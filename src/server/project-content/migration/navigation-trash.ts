import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type { DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import type { ProjectNavigationOperation } from "../navigation-operation-file.js";
import type { ProjectNavigationTrash } from "../navigation-file.js";
import { contentRequestHash } from "../mutation.js";
import type { LegacyProjectMetadata } from "./legacy-metadata.js";

/** Legacy single-item deletions acquire stable restoration receipts without altering the source database. */
export function planLegacyTrash(
  metadata: LegacyProjectMetadata,
  spaceId: string,
  version: number,
  documents: readonly DocumentRecord[],
  nodes: readonly DocumentTreePlacement[],
) {
  const deleted = new Map(metadata.trash.map((row) => [row.documentId, row.deletedAt])),
    known = new Map(nodes.map((row) => [row.documentId, row])),
    tombstones = new Map(
      metadata.navigation.tombstones.filter((row) => row.spaceId === spaceId).map((row) => [row.documentId, row]),
    ),
    missing = new Set(
      nodes
        .filter((row) => deleted.has(row.documentId) && !tombstones.has(row.documentId))
        .map((row) => row.documentId),
    ),
    groups = new Map<string, string[]>(),
    operations: ProjectNavigationOperation[] = [],
    receipts = new Map<string, string>();
  for (const id of missing) {
    let root = id,
      parent = known.get(id)!.parentId;
    while (parent && missing.has(parent)) {
      root = parent;
      parent = known.get(root)!.parentId;
    }
    const members = groups.get(root) ?? [];
    members.push(id);
    groups.set(root, members);
  }
  for (const [root, members] of groups) {
    const affectedDocumentIds = members.sort(),
      request = contentRequestHash({ spaceId, root, members: affectedDocumentIds, version }),
      id = "legacy-trash-" + request;
    operations.push({
      id,
      spaceId,
      owner: "system:file-import",
      request,
      documentId: root,
      createdAt: Math.max(...members.map((id) => deleted.get(id)!)),
      result: { id, documentId: root, affectedDocumentIds, treeVersion: version, restoredToRoot: false },
    });
    for (const member of members) receipts.set(member, id);
  }
  const trash: ProjectNavigationTrash[] = documents
    .filter((row) => deleted.has(row.id))
    .map((document) => {
      const tombstone = tombstones.get(document.id),
        operationId = tombstone?.operationId ?? receipts.get(document.id) ?? null,
        saved = tombstone ?? (operationId ? known.get(document.id) : undefined);
      return {
        documentId: document.id,
        deletedAt: deleted.get(document.id)!,
        parentId: saved?.parentId ?? null,
        position: saved?.position ?? null,
        operationId,
      };
    });
  return { trash, operations };
}
