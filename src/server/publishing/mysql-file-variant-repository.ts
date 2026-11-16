import type { PublicationGuard } from "./content/source-port.js";
import type { SQL } from "bun";
import { MySQLLedger, type MySQLLedgerTransaction } from "../packages/mysql-ledger.js";
import type { ContentVariant, ContentIR, VariantSource } from "../../shared/publishing/content.js";
import type { VariantReview } from "../../shared/publishing/variants.js";
import { variantSummary } from "./variant-summary.js";
import { variantContentDigest } from "./variant-content.js";
import { publicationDigest, publicationSummaryDigest } from "./schema.js";
import { PublicationError } from "./errors.js";
/** File variants persist only source bindings, immutable artifact references, summaries and review metadata in SQL. */
export class MySQLFileVariantRepository extends MySQLLedger {
  constructor(pool: SQL, documentTransaction?: MySQLLedgerTransaction) {
    super(pool, "panda_force_publishing_guard", [], documentTransaction);
  }
  async register(variant: ContentVariant, ir: ContentIR, guard: PublicationGuard = () => {}) {
    return this.transaction(async () => {
      await guard();
      const source = variant.source;
      if (
        !source.projectId ||
        ir.projectId !== source.projectId ||
        ir.commit !== source.commit ||
        !source.commit ||
        !/^[a-f0-9]{40}$/.test(source.commit)
      )
        throw new PublicationError("invalidInput");
      const digest = variantContentDigest({ variant, ir }),
        payload = JSON.stringify({ schema: 1, id: variant.id, source }),
        location = JSON.stringify({ storage: "file", digest }),
        summary = JSON.stringify(variantSummary(variant));
      await this.query(
        "INSERT INTO panda_force_publication_variants(id,documentId,revisionId,payload,digest,createdAt,sourceSnapshot,sourceProjectId,summary,summaryDigest,referenceDigest) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        variant.id,
        source.documentId,
        source.revisionId,
        payload,
        digest,
        variant.createdAt,
        location,
        source.projectId,
        summary,
        publicationSummaryDigest(summary, source.documentId, source.revisionId, source.projectId),
        publicationDigest(payload + "\n" + location + "\n" + digest),
      );
    });
  }
  async reference(id: string): Promise<{
    source: VariantSource;
    digest: string;
    review: VariantReview | null;
  } | null> {
    return this.readSnapshot(async () => {
      const row = await this.query<
        {
          documentId: string;
          revisionId: string;
          sourceProjectId: string;
          payload: string;
          digest: string;
          review: string | null;
          sourceSnapshot: string;
          referenceDigest: string;
        },
        [string]
      >(
        "SELECT documentId,revisionId,sourceProjectId,payload,digest,review,sourceSnapshot,referenceDigest FROM panda_force_publication_variants WHERE id=? AND sourceProjectId IS NOT NULL",
      ).get(id);
      if (!row) return null;
      if (publicationDigest(row.payload + "\n" + row.sourceSnapshot + "\n" + row.digest) !== row.referenceDigest)
        throw new PublicationError("unavailable", 503);
      const value = JSON.parse(row.payload) as {
          schema: number;
          id: string;
          source: VariantSource;
        },
        location = JSON.parse(row.sourceSnapshot) as {
          storage: string;
          digest: string;
        };
      if (
        value.schema !== 1 ||
        value.id !== id ||
        value.source.documentId !== row.documentId ||
        value.source.revisionId !== row.revisionId ||
        value.source.projectId !== row.sourceProjectId ||
        !value.source.commit ||
        !/^[a-f0-9]{40}$/.test(value.source.commit) ||
        location.storage !== "file" ||
        location.digest !== row.digest
      )
        throw new PublicationError("unavailable", 503);
      const review = row.review ? (JSON.parse(row.review) as VariantReview) : null;
      if (review && review.digest !== row.digest) throw new PublicationError("unavailable", 503);
      return { source: value.source, digest: row.digest, review };
    });
  }
}
