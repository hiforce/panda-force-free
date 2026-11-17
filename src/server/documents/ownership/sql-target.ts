import { createHash } from "node:crypto";
import type { DocumentAsset, DocumentSpace } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { insertTreeNodes } from "../../../shared/documents/navigation-structure.js";
import { DocumentError } from "../errors.js";
import {
  ownershipSQLInsert,
  ownershipSQLTable,
  type OwnershipSQLBatch,
  type OwnershipSQLStatement,
} from "./sql-batch.js";
import { sqlOwnershipOperation, sqlOwnershipReceipt, sqlOwnershipTree } from "./sql-operations.js";
import { sqlOwnershipTargetState, sqlOwnershipOriginals, sqlOwnershipTargetPlacements } from "./sql-target-policy.js";
import { ownershipRecordText } from "./record.js";
import { assertOwnershipPlan, ownershipRecord } from "./plan.js";
import type { DocumentOwnershipInventory, DocumentOwnershipOriginals, DocumentOwnershipPlan } from "./contracts.js";

/** The relational target publishes all preserved rows and placement in one transaction after source removal. */
export class SQLDocumentOwnershipTarget {
  constructor(
    private readonly db: OwnershipSQLBatch,
    private readonly ensure: (project: string, locale: string) => Promise<DocumentSpace>,
    private readonly authorize: (project: string) => void | Promise<void>,
    private readonly writeImage: (asset: DocumentAsset, bytes: Uint8Array) => Promise<void>,
    private readonly readImage: (asset: DocumentAsset) => Promise<Uint8Array>,
  ) {}
  async receipt(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory) {
    assertOwnershipPlan(plan, inventory);
    await this.authorize(plan.to.projectId);
    const result = await sqlOwnershipReceipt(this.db, plan, inventory, "activate");
    await this.authorize(plan.to.projectId);
    return result;
  }
  private checkImage(asset: DocumentAsset, bytes: Uint8Array) {
    if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.digest)
      throw new DocumentError("sourceUnavailable", 503);
  }
  async stage(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    originals: DocumentOwnershipOriginals,
    assertCurrent: () => Promise<void>,
  ) {
    assertOwnershipPlan(plan, inventory);
    if (await this.receipt(plan, inventory)) return;
    await assertCurrent();
    await this.ensure(
      plan.to.projectId,
      inventory.nodes.find((row) => row.documentId === inventory.rootDocumentId)!.document.locale,
    );
    await this.verify(plan, inventory, originals, false);
    for (const asset of inventory.assets) {
      const original = await originals.image(asset.id);
      if (stableJson(original.asset) !== stableJson(asset)) throw new DocumentError("conflict", 409);
      this.checkImage(asset, original.bytes);
      await this.authorize(plan.to.projectId);
      await this.writeImage(asset, original.bytes);
    }
    await assertCurrent();
    await this.verify(plan, inventory, originals);
  }
  async verify(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    originals: DocumentOwnershipOriginals,
    images = true,
  ) {
    assertOwnershipPlan(plan, inventory);
    await this.authorize(plan.to.projectId);
    const state = await sqlOwnershipTargetState(this.db, plan, inventory, originals);
    sqlOwnershipTargetPlacements(state, plan, inventory);
    await sqlOwnershipOriginals(inventory, originals);
    if (images) for (const asset of inventory.assets) this.checkImage(asset, await this.readImage(asset));
    await this.authorize(plan.to.projectId);
  }
  async activate(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    assertRemoved: () => Promise<void>,
    originals: DocumentOwnershipOriginals,
  ) {
    assertOwnershipPlan(plan, inventory);
    const done = await this.receipt(plan, inventory);
    if (done) return done;
    await assertRemoved();
    const versions = await sqlOwnershipOriginals(inventory, originals),
      state = await sqlOwnershipTargetState(this.db, plan, inventory, originals),
      additions = sqlOwnershipTargetPlacements(state, plan, inventory),
      spaceId = state.space!.id,
      next = insertTreeNodes(state.tree, additions),
      changes: OwnershipSQLStatement[] = [],
      table = (name: Parameters<typeof ownershipSQLTable>[1]) => ownershipSQLTable(this.db, name);
    for (const asset of inventory.assets) this.checkImage(asset, await this.readImage(asset));
    for (const node of inventory.nodes) {
      const previous = state.documents.find((row) => row.id === node.documentId),
        document = {
          ...node.document,
          spaceId,
          path: previous?.spaceId === spaceId ? previous.path : node.documentId + ".md",
        };
      if (previous) {
        const values = {
            ...document,
            ...(this.db.mysql ? { pathHash: createHash("sha256").update(document.path).digest("hex") } : {}),
          },
          columns = Object.keys(values).filter((key) => key !== "id") as (keyof typeof values)[];
        changes.push({
          sql: `UPDATE ${table("documents")} SET ${columns.map((key) => key + "=?").join(",")} WHERE id=?`,
          values: [...columns.map((key) => values[key]!), document.id],
        });
      } else
        changes.push(
          ownershipSQLInsert(this.db, "documents", {
            ...document,
            ...(this.db.mysql ? { pathHash: createHash("sha256").update(document.path).digest("hex") } : {}),
          }),
        );
    }
    for (const asset of inventory.assets)
      if (!state.assets.some((row) => row.id === asset.id))
        changes.push(ownershipSQLInsert(this.db, "document_assets", { ...asset }));
    for (const detail of versions) {
      const revision = detail.revision;
      if (state.revisions.some((row) => row.id === revision.id)) continue;
      const { body, resources, ...row } = revision;
      changes.push(ownershipSQLInsert(this.db, "document_revisions", { ...row }));
      if (body)
        changes.push(
          ownershipSQLInsert(this.db, "document_rich_revisions", { revisionId: revision.id, body: stableJson(body) }),
        );
      for (const resource of resources ?? []) {
        if (
          !inventory.assets.some(
            (asset) =>
              asset.id === resource.assetId &&
              asset.documentId === revision.documentId &&
              asset.digest === resource.digest,
          )
        )
          throw new DocumentError("invalidImage");
        changes.push(
          ownershipSQLInsert(this.db, "document_revision_assets", {
            revisionId: revision.id,
            source: resource.source,
            sourcePath: resource.sourcePath,
            assetId: resource.assetId,
            ...(this.db.mysql ? { sourceHash: createHash("sha256").update(resource.source).digest("hex") } : {}),
          }),
        );
      }
    }
    for (const node of inventory.nodes)
      changes.push(
        {
          sql: `DELETE FROM ${table("document_ownership_records")} WHERE spaceId=? AND documentId=?`,
          values: [spaceId, node.documentId],
        },
        ownershipSQLInsert(this.db, "document_ownership_records", {
          spaceId,
          documentId: node.documentId,
          record: ownershipRecordText(ownershipRecord(plan, inventory, node.documentId, "active")),
        }),
        { sql: `DELETE FROM ${table("document_trash")} WHERE documentId=?`, values: [node.documentId] },
        { sql: `DELETE FROM ${table("document_tree_trash")} WHERE documentId=?`, values: [node.documentId] },
      );
    changes.push(
      ...sqlOwnershipTree(this.db, spaceId, next, state.version! + 1),
      sqlOwnershipOperation(this.db, plan, inventory, "activate", spaceId, state.version! + 1),
    );
    await this.authorize(plan.to.projectId);
    await assertRemoved();
    await this.db.commit(state.checks, changes);
    const receipt = await this.receipt(plan, inventory);
    if (!receipt) throw new DocumentError("sourceUnavailable", 503);
    return receipt;
  }
}
