import type { ContentIR, ContentVariant } from "../../../shared/publishing/content.js";
import type { VariantReview } from "../../../shared/publishing/variants.js";
import { LegacyHistoryContext, historyHash, historyJson, invalidHistory } from "./context.js";

/** Legacy payload and intermediate representation remain byte-identical, including their original digest. */
export function inventoryLegacyVariants(c: LegacyHistoryContext): void {
  const version = c.domain("publication_schema", 2, [
    ["publication_variants", 1],
    ["publication_reviews", 1],
  ]);
  if (!version) return;
  if (version >= 2) c.legacyScope("publication_variants", "sourceProjectId");
  const rows = c.db.query<
    {
      id: string;
      documentId: string;
      revisionId: string;
      payload: string;
      sourceSnapshot: string;
      digest: string;
      review: string | null;
      sourceProjectId?: string | null;
    },
    [string]
  >(`SELECT * FROM publication_variants WHERE documentId IN (${c.documentFilter}) ORDER BY id`);
  for (const row of rows.iterate(c.projectId)) {
    if (row.sourceProjectId != null || historyHash(row.payload + "\n" + row.sourceSnapshot) !== row.digest)
      return invalidHistory();
    const variant = historyJson<ContentVariant>(row.payload),
      ir = historyJson<ContentIR>(row.sourceSnapshot);
    if (
      variant?.id !== row.id ||
      variant.source?.documentId !== row.documentId ||
      variant.source.revisionId !== row.revisionId ||
      ir?.documentId !== row.documentId ||
      ir.revisionId !== row.revisionId ||
      ir.sourceHash !== variant.source.sourceHash ||
      ir.projectId !== undefined ||
      ir.commit !== undefined
    )
      return invalidHistory();
    c.source(variant.source);
    if (row.review !== null && historyJson<VariantReview>(row.review)?.digest !== row.digest) return invalidHistory();
    c.archive("publication_variants", row.id, row);
    c.variants.set(row.id, { documentId: row.documentId, revisionId: row.revisionId, digest: row.digest });
  }
  c.children("publication_reviews", "variantId", new Set(c.variants.keys()), (row) => {
    const review = historyJson<VariantReview>(row.payload);
    if (review?.digest !== c.variants.get(String(row.variantId))?.digest) return invalidHistory();
    return String(row.id);
  });
}
