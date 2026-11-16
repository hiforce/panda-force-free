import type { PublicationGuard } from "./content/source-port.js";
import type { VariantStore } from "./ports.js";
import type { SQL } from "bun";
import { MySQLLedger, type MySQLLedgerTransaction } from "../packages/mysql-ledger.js";
import { createHash } from "node:crypto";
import type { ContentIR, ContentVariant } from "../../shared/publishing/content.js";
import type { VariantReview, VariantSummary } from "../../shared/publishing/variants.js";
import { PublicationError } from "./errors.js";
import { publicationSummaryDigest } from "./schema.js";
import { variantSummary } from "./variant-summary.js";
import { MySQLFileVariantRepository } from "./mysql-file-variant-repository.js";
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
export class MySQLVariantRepository extends MySQLLedger implements VariantStore {
  readonly asynchronous = true;
  public override transaction<T>(work: () => Promise<T>): Promise<T> {
    return super.transaction(work);
  }
  readonly files: MySQLFileVariantRepository;
  constructor(pool: SQL, documentTransaction?: MySQLLedgerTransaction) {
    super(pool, "panda_force_publishing_guard", ["createdAt"], documentTransaction);
    this.files = new MySQLFileVariantRepository(pool, documentTransaction);
  }
  async create(variant: ContentVariant, ir: ContentIR, guard: PublicationGuard = () => {}) {
    return this.transaction(async () => {
      await guard();
      if (variant.source.projectId !== undefined) throw new PublicationError("invalidInput");
      const payload = JSON.stringify(variant),
        sourceSnapshot = JSON.stringify(ir),
        summary = JSON.stringify(variantSummary(variant)),
        digest = createHash("sha256").update(payload).update("\n").update(sourceSnapshot).digest("hex");
      await this.query(
        "INSERT INTO panda_force_publication_variants(id,documentId,revisionId,payload,digest,createdAt,sourceSnapshot,sourceProjectId,summary,summaryDigest) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
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
      return await this.get(variant.id);
    });
  }
  async get(id: string): Promise<{
    variant: ContentVariant;
    digest: string;
    review: VariantReview | null;
  }> {
    return this.readSnapshot(async () => {
      const row = await this.row(id);
      return {
        variant: JSON.parse(row.payload) as ContentVariant,
        digest: row.digest,
        review: row.review ? (JSON.parse(row.review) as VariantReview) : null,
      };
    });
  }
  async source(id: string): Promise<ContentIR> {
    return this.readSnapshot(async () => {
      return JSON.parse((await this.row(id)).sourceSnapshot) as ContentIR;
    });
  }
  private async row(id: string) {
    const row = await this.query<Row, [string]>(
      "SELECT documentId,revisionId,sourceProjectId,payload,digest,review,sourceSnapshot FROM panda_force_publication_variants WHERE id=?",
    ).get(id);
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
  async list(documentId: string, projectId?: string): Promise<VariantSummary[]> {
    return this.readSnapshot(async () => {
      return (
        await this.query<
          {
            id: string;
            revisionId: string;
            summary: string;
            summaryDigest: string;
          },
          [string, string | null]
        >(
          "SELECT id,revisionId,summary,summaryDigest FROM panda_force_publication_variants WHERE documentId=? AND sourceProjectId <=> ? ORDER BY createdAt DESC,sequence DESC LIMIT 100",
        ).all(documentId, projectId ?? null)
      ).map((row) => {
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
    });
  }
  async review(id: string, review: VariantReview, guard: PublicationGuard = () => {}) {
    return this.transaction(async () => {
      await guard();
      const current = await this.query<{ id: string }, [string, string]>(
        "SELECT id FROM panda_force_publication_variants WHERE id=? AND digest=? FOR UPDATE",
      ).get(id, review.digest);
      if (!current) throw new PublicationError("staleVariant", 409);
      await this.query("UPDATE panda_force_publication_variants SET review=? WHERE id=?").run(
        JSON.stringify(review),
        id,
      );
      await this.query("INSERT INTO panda_force_publication_reviews(variantId,payload,reviewedAt) VALUES(?,?,?)").run(
        id,
        JSON.stringify(review),
        review.reviewedAt,
      );
      return review;
    });
  }
}
