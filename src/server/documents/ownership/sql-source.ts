import type {
  DocumentAsset,
  DocumentDetail,
  DocumentRecord,
  DocumentRevision,
} from "../../../shared/documents/contracts.js";
import { documentSubtree, type ProjectDocumentTree } from "../../../shared/documents/navigation.js";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeProjectDocument, encodeProjectDocument } from "../../project-content/document-file.js";
import { projectRevisionSummary } from "../../project-content/document-history.js";
import { DocumentError } from "../errors.js";
import type { DocumentOwnershipInventory } from "./contracts.js";
import { ownershipSQLTable, type OwnershipSQLBatch } from "./sql-batch.js";
import { sqlOwnershipSnapshot, type SQLOwnershipSnapshot } from "./sql-snapshot.js";

export interface SQLDocumentOwnershipSnapshot {
  inventory: DocumentOwnershipInventory;
  state: SQLOwnershipSnapshot;
}
/** Relational revisions remain immutable after removal; the accepted snapshot grants no public read bypass. */
export class SQLDocumentOwnershipSource {
  get relationalOrigin() {
    return this.db;
  }
  constructor(
    private readonly db: OwnershipSQLBatch,
    private readonly tree: (project: string) => ProjectDocumentTree | Promise<ProjectDocumentTree>,
    private readonly imageBytes: (asset: DocumentAsset) => Promise<Uint8Array>,
    private readonly authorize: (project: string) => void | Promise<void>,
  ) {}
  inventory(snapshot: SQLDocumentOwnershipSnapshot) {
    return structuredClone(snapshot.inventory);
  }
  async capture(projectId: string, rootDocumentId: string): Promise<SQLDocumentOwnershipSnapshot> {
    await this.authorize(projectId);
    const tree = await this.tree(projectId),
      ids = documentSubtree(tree.nodes, rootDocumentId),
      state = await sqlOwnershipSnapshot(this.db, projectId, ids);
    if (
      !state.space ||
      state.version !== tree.version ||
      !ids.length ||
      state.trash.length ||
      state.documents.length !== ids.length
    )
      throw new DocumentError("conflict", 409);
    const nodes = tree.nodes.filter((node) => ids.includes(node.documentId));
    for (const node of nodes) {
      const document = state.documents.find((row) => row.id === node.documentId),
        placement = state.tree.find((row) => row.documentId === node.documentId);
      if (
        document?.spaceId !== state.space.id ||
        stableJson(document) !== stableJson(node.document) ||
        stableJson(placement) !==
          stableJson({ documentId: node.documentId, parentId: node.parentId, position: node.position })
      )
        throw new DocumentError("conflict", 409);
    }
    const ownership = state.ownership.filter((row) => row.spaceId === state.space!.id).map((row) => row.record);
    if (ownership.some((row) => row.kind !== "active" || row.to.projectId !== projectId))
      throw new DocumentError("conflict", 409);
    await this.authorize(projectId);
    return {
      inventory: {
        projectId,
        rootDocumentId,
        nodes,
        assets: state.assets,
        ownership: ownership.sort((a, b) => a.documentId.localeCompare(b.documentId, "en")),
        revisions: state.revisions,
      },
      state,
    };
  }
  async assertCurrent(snapshot: SQLDocumentOwnershipSnapshot) {
    await this.authorize(snapshot.inventory.projectId);
    const actual = await sqlOwnershipSnapshot(
      this.db,
      snapshot.inventory.projectId,
      snapshot.inventory.nodes.map((row) => row.documentId),
    );
    if (stableJson(actual) !== stableJson(snapshot.state)) throw new DocumentError("conflict", 409);
    await this.authorize(snapshot.inventory.projectId);
  }
  async version(
    snapshot: SQLDocumentOwnershipSnapshot,
    documentId: string,
    revisionId: string,
  ): Promise<DocumentDetail> {
    await this.authorize(snapshot.inventory.projectId);
    const expected = snapshot.inventory.revisions.find((row) => row.documentId === documentId && row.id === revisionId),
      current = snapshot.inventory.nodes.find((row) => row.documentId === documentId)?.document;
    if (!expected || !current) throw new DocumentError("notFound", 404);
    const table = (name: Parameters<typeof ownershipSQLTable>[1]) => ownershipSQLTable(this.db, name),
      [versions, rich, resources] = await this.db.read([
        {
          sql: `SELECT * FROM ${table("document_revisions")} WHERE documentId=? AND id=?`,
          values: [documentId, revisionId],
        },
        { sql: `SELECT body FROM ${table("document_rich_revisions")} WHERE revisionId=?`, values: [revisionId] },
        {
          sql: `SELECT r.source,r.sourcePath,r.assetId,a.digest FROM ${table("document_revision_assets")} r JOIN ${table("document_assets")} a ON a.id=r.assetId WHERE r.revisionId=? ORDER BY r.source`,
          values: [revisionId],
        },
      ]),
      raw = versions![0] as unknown as DocumentRevision;
    if (!raw || stableJson(projectRevisionSummary(raw)) !== stableJson(expected))
      throw new DocumentError("conflict", 409);
    const revision: DocumentRevision = {
        ...raw,
        ...(rich![0] ? { body: JSON.parse(String(rich![0].body)) } : {}),
        resources: resources as unknown as NonNullable<DocumentRevision["resources"]>,
      },
      document: DocumentRecord =
        revision.number === current.revision
          ? current
          : {
              ...current,
              title: revision.title,
              locale: revision.locale,
              revision: revision.number,
              revisionId: revision.id,
              contentHash: revision.contentHash,
              updatedAt: revision.createdAt,
              ...(current.importedRevision !== null && current.importedRevision > revision.number
                ? { importedRevision: null, importedHash: null }
                : {}),
            },
      detail = decodeProjectDocument(encodeProjectDocument({ document, revision }));
    await this.authorize(snapshot.inventory.projectId);
    return detail;
  }
  async image(snapshot: SQLDocumentOwnershipSnapshot, id: string) {
    await this.authorize(snapshot.inventory.projectId);
    const asset = snapshot.inventory.assets.find((row) => row.id === id);
    if (!asset) throw new DocumentError("notFound", 404);
    const bytes = await this.imageBytes(asset);
    await this.authorize(snapshot.inventory.projectId);
    return { asset, bytes };
  }
}
