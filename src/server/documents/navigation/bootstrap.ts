import { randomUUID } from "node:crypto";
import { emptyRichBody } from "../../../shared/documents/rich-body.js";
import {
  DOCUMENT_TREE_LIMITS,
  validateDocumentTree,
  DocumentTreeError,
  type DocumentTreePlacement,
} from "../../../shared/documents/navigation.js";
import type { ProjectDocumentLibrary } from "../library-service.js";
import type { DocumentService } from "../service.js";
import { DocumentError } from "../errors.js";
import type { DocumentNavigationRepository, DocumentTreeRow } from "./repository.js";
import { insertTreeNodes, liftRemovedNodes } from "../../../shared/documents/navigation-structure.js";
import { navigationGuard, navigationRequest } from "./validation.js";

export const treePlacements = (rows: DocumentTreeRow[]): DocumentTreePlacement[] =>
  rows.map(({ documentId, parentId, position }) => ({ documentId, parentId, position }));
function title(value: string) {
  let output = "";
  for (const part of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)) {
    if (output.length + part.segment.length > 200) break;
    output += part.segment;
  }
  return output.trim() || "Document";
}
/** Conversion and compatibility reconciliation own no host files and never hydrate existing document bodies. */
export class DocumentNavigationBootstrap {
  constructor(
    private repository: DocumentNavigationRepository,
    private library: ProjectDocumentLibrary,
    private documents: DocumentService,
  ) {}
  ensure(projectId: string) {
    const space = this.library.get(projectId);
    if (!space) return null;
    navigationGuard(() =>
      this.repository.transaction(() => {
        if (this.repository.version(space.id) === null) {
          const originals = this.repository.unregistered(space.id),
            paths = new Set<string>();
          for (const path of [
            ...this.library.overview(projectId).folders.map((folder) => folder.path),
            ...originals.map((document) => document.path.split("/").slice(0, -1).join("/")),
          ]) {
            const parts = path.split("/").filter(Boolean);
            parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
          }
          if (originals.length + paths.size > DOCUMENT_TREE_LIMITS.documents)
            throw new DocumentError("tooManyDocuments", 409);
          const origins = new Map<string, string>(),
            placements: DocumentTreePlacement[] = [],
            counts = new Map<string | null, number>();
          const append = (documentId: string, parentId: string | null) => {
            const position = counts.get(parentId) || 0;
            counts.set(parentId, position + 1);
            placements.push({ documentId, parentId, position });
          };
          for (const path of [...paths].sort(
            (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"),
          )) {
            const detail = this.documents.createDocument({
              spaceId: space.id,
              path: randomUUID() + ".md",
              title: title(path.split("/").at(-1)!),
              locale: space.locale,
              body: emptyRichBody(),
            });
            origins.set(path, detail.document.id);
            append(detail.document.id, origins.get(path.split("/").slice(0, -1).join("/")) || null);
            this.repository.origin(space.id, path, detail.document.id);
          }
          for (const document of originals.sort(
            (a, b) => a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id, "en"),
          ))
            append(document.id, origins.get(document.path.split("/").slice(0, -1).join("/")) || null);
          this.repository.initialize(space.id, placements);
        }
        this.reconcileDeletion(space.id);
        this.registerNewDocuments(space.id);
      }),
    );
    return space;
  }
  private reconcileDeletion(spaceId: string) {
    const rows = this.repository.rows(spaceId),
      removed = new Set(rows.filter((row) => row.trashed).map((row) => row.documentId));
    if (!removed.size) return;
    const placements = treePlacements(rows),
      known = new Map(placements.map((node) => [node.documentId, node]));
    validateDocumentTree(placements);
    const groups = new Map<string, string[]>(),
      version = this.repository.version(spaceId)!;
    for (const id of removed) {
      let root = id,
        parent = known.get(root)!.parentId;
      while (parent && removed.has(parent)) {
        root = parent;
        parent = known.get(root)!.parentId;
      }
      const list = groups.get(root) || [];
      list.push(id);
      groups.set(root, list);
    }
    for (const [root, ids] of groups) {
      const id = randomUUID();
      this.repository.retire(spaceId, ids, id);
      this.repository.recordOperation(
        spaceId,
        "system:navigation-compat",
        id,
        navigationRequest({ kind: "legacy-trash", ids: ids.toSorted(), version }),
        root,
        { id, documentId: root, affectedDocumentIds: ids, treeVersion: version + 1, restoredToRoot: false },
      );
    }
    this.repository.replace(spaceId, liftRemovedNodes(placements, removed));
    this.repository.bump(spaceId, version);
  }
  private registerNewDocuments(spaceId: string) {
    const documents = this.repository.unregistered(spaceId);
    if (!documents.length) return;
    const rows = this.repository.rows(spaceId),
      base = treePlacements(rows),
      known = new Set([...base.map((node) => node.documentId), ...documents.map((document) => document.id)]),
      origins = this.repository.origins(spaceId);
    if (base.length + documents.length > DOCUMENT_TREE_LIMITS.documents)
      throw new DocumentError("tooManyDocuments", 409);
    const counts = new Map<string | null, number>();
    for (const node of base) counts.set(node.parentId, Math.max(counts.get(node.parentId) || 0, node.position + 1));
    const additions = documents.map((document) => {
      const previous = this.repository.tombstone(spaceId, document.id),
        candidate = previous
          ? previous.parentId
          : (origins.get(document.path.split("/").slice(0, -1).join("/")) ?? null),
        parentId = candidate && known.has(candidate) ? candidate : null,
        position = previous?.position ?? counts.get(parentId) ?? 0;
      counts.set(parentId, Math.max(counts.get(parentId) || 0, position + 1));
      return { documentId: document.id, parentId, position };
    });
    let next: DocumentTreePlacement[];
    try {
      next = insertTreeNodes(base, additions);
    } catch (error) {
      if (!(error instanceof DocumentTreeError)) throw error;
      const pending = new Set(additions.map((node) => node.documentId));
      for (const node of additions) {
        if (node.parentId === null || !pending.has(node.parentId)) node.parentId = null;
      }
      next = insertTreeNodes(base, additions);
    }
    const version = this.repository.version(spaceId)!;
    for (const node of additions) this.repository.insert(spaceId, node);
    this.repository.replace(spaceId, next);
    this.repository.forgetTombstones(additions.map((node) => node.documentId));
    this.repository.bump(spaceId, version);
  }
}
