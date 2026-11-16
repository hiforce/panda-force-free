import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ContentIR, ContentVariant } from "../../shared/publishing/content.js";
import type { VariantReview, VariantSummary } from "../../shared/publishing/variants.js";
import { PublicationError } from "./errors.js";
import { migratePublicationVariants, publicationSummaryDigest } from "./schema.js";
import { variantSummary } from "./variant-summary.js";
import { FileVariantRepository } from "./file-variant-repository.js";

interface Row {
  documentId: string;
  revisionId: string;
  sourceProjectId: string | null;
  payload: string;
  digest: string;
  review: string | null;
  sourceSnapshot: string;
}
/** Immutable variants and their explicit review records share a transaction boundary. */
export class VariantRepository {
  readonly files: FileVariantRepository;
  constructor(private db: Database) {
    migratePublicationVariants(db);
    this.files = new FileVariantRepository(db);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  create(variant: ContentVariant, ir: ContentIR, guard: () => void = () => {}) {
    guard();
    if (variant.source.projectId !== undefined) throw new PublicationError("invalidInput");
    const payload = JSON.stringify(variant),
      sourceSnapshot = JSON.stringify(ir),
      summary = JSON.stringify(variantSummary(variant)),
      digest = createHash("sha256").update(payload).update("\n").update(sourceSnapshot).digest("hex");
    this.db
      .query(
        "INSERT INTO publication_variants(id,documentId,revisionId,payload,digest,createdAt,sourceSnapshot,sourceProjectId,summary,summaryDigest) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        variant.id,
        variant.source.documentId,
        variant.source.revisionId,
        payload,
        digest,
        variant.createdAt,
        sourceSnapshot,
        variant.source.projectId ?? null,
        summary,
        publicationSummaryDigest(summary, variant.source.documentId, variant.source.revisionId),
      );
    return this.get(variant.id);
  }
  get(id: string): { variant: ContentVariant; digest: string; review: VariantReview | null } {
    const row = this.row(id);
    return {
      variant: JSON.parse(row.payload) as ContentVariant,
      digest: row.digest,
      review: row.review ? (JSON.parse(row.review) as VariantReview) : null,
    };
  }
  source(id: string): ContentIR {
    return JSON.parse(this.row(id).sourceSnapshot) as ContentIR;
  }
  private row(id: string) {
    const row = this.db
      .query<Row, [string]>(
        "SELECT documentId,revisionId,sourceProjectId,payload,digest,review,sourceSnapshot FROM publication_variants WHERE id=?",
      )
      .get(id);
    if (!row) throw new PublicationError("notFound", 404);
    if (row.sourceProjectId !== null) throw new PublicationError("notFound", 404);
    if (createHash("sha256").update(row.payload).update("\n").update(row.sourceSnapshot).digest("hex") !== row.digest)
      throw new PublicationError("unavailable", 503);
    const variant = JSON.parse(row.payload) as ContentVariant,
      ir = JSON.parse(row.sourceSnapshot) as ContentIR;
    if (
      variant.id !== id ||
      variant.source.documentId !== row.documentId ||
      variant.source.revisionId !== row.revisionId ||
      (variant.source.projectId ?? null) !== row.sourceProjectId ||
      ir.documentId !== row.documentId ||
      ir.revisionId !== row.revisionId ||
      ir.projectId !== variant.source.projectId ||
      ir.commit !== variant.source.commit ||
      ir.sourceHash !== variant.source.sourceHash ||
      (ir.commit !== undefined && (!ir.projectId || !/^[a-f0-9]{40}$/.test(ir.commit)))
    )
      throw new PublicationError("unavailable", 503);
    return row;
  }
  list(documentId: string, projectId?: string): VariantSummary[] {
    return this.db
      .query<{ id: string; revisionId: string; summary: string; summaryDigest: string }, [string, string | null]>(
        "SELECT id,revisionId,summary,summaryDigest FROM publication_variants WHERE documentId=? AND sourceProjectId IS ? ORDER BY createdAt DESC,rowid DESC LIMIT 100",
      )
      .all(documentId, projectId ?? null)
      .map((row) => {
        if (
          typeof row.summary !== "string" ||
          publicationSummaryDigest(row.summary, documentId, row.revisionId, projectId) !== row.summaryDigest
        )
          throw new PublicationError("unavailable", 503);
        const summary = JSON.parse(row.summary) as VariantSummary;
        if (summary.id !== row.id || summary.revisionId !== row.revisionId)
          throw new PublicationError("unavailable", 503);
        return summary;
      });
  }
  review(id: string, review: VariantReview, guard: () => void = () => {}) {
    return this.db
      .transaction(() => {
        guard();
        const result = this.db
          .query("UPDATE publication_variants SET review=? WHERE id=? AND digest=?")
          .run(JSON.stringify(review), id, review.digest);
        if (result.changes !== 1) throw new PublicationError("staleVariant", 409);
        this.db
          .query("INSERT INTO publication_reviews(variantId,payload,reviewedAt) VALUES(?,?,?)")
          .run(id, JSON.stringify(review), review.reviewedAt);
        return review;
      })
      .immediate();
  }
}
