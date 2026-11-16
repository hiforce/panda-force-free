import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ContentVariant } from "../../shared/publishing/content.js";
import { PublicationError } from "./errors.js";
import { variantSummary } from "./variant-summary.js";

export const publicationDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export const publicationSummaryDigest = (summary: string, documentId: string, revisionId: string, projectId?: string) =>
  publicationDigest(JSON.stringify([projectId ?? null, documentId, revisionId, summary]));
export function migratePublicationVariants(db: Database) {
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
    );
    const version =
      db.query<{ version: number }, []>("SELECT version FROM publication_schema WHERE id=1").get()?.version ?? 0;
    if (version > 2) throw new PublicationError("unavailable", 503);
    if (version < 1) {
      db.exec(`CREATE TABLE publication_variants (
        id TEXT PRIMARY KEY, documentId TEXT NOT NULL, revisionId TEXT NOT NULL, payload TEXT NOT NULL,
        digest TEXT NOT NULL, review TEXT, createdAt INTEGER NOT NULL, sourceSnapshot TEXT NOT NULL
      ); CREATE INDEX variants_by_document ON publication_variants(documentId,createdAt DESC);
      CREATE TABLE publication_reviews (id INTEGER PRIMARY KEY, variantId TEXT NOT NULL REFERENCES publication_variants(id), payload TEXT NOT NULL, reviewedAt INTEGER NOT NULL);
      INSERT INTO publication_schema(id,version) VALUES(1,1);`);
    }
    if (version < 2) {
      db.exec(`ALTER TABLE publication_variants ADD COLUMN sourceProjectId TEXT;
        ALTER TABLE publication_variants ADD COLUMN summary TEXT;
        ALTER TABLE publication_variants ADD COLUMN summaryDigest TEXT;
        ALTER TABLE publication_variants ADD COLUMN referenceDigest TEXT;
        CREATE INDEX variants_by_scoped_document ON publication_variants(sourceProjectId,documentId,createdAt DESC);`);
      for (const row of db
        .query<
          {
            id: string;
            documentId: string;
            revisionId: string;
            payload: string;
            digest: string;
            sourceSnapshot: string;
          },
          []
        >("SELECT id,documentId,revisionId,payload,digest,sourceSnapshot FROM publication_variants")
        .iterate()) {
        if (publicationDigest(row.payload + "\n" + row.sourceSnapshot) !== row.digest)
          throw new PublicationError("unavailable", 503);
        const variant = JSON.parse(row.payload) as ContentVariant;
        if (
          variant.id !== row.id ||
          variant.source.documentId !== row.documentId ||
          variant.source.revisionId !== row.revisionId ||
          variant.source.projectId !== undefined
        )
          throw new PublicationError("unavailable", 503);
        const summary = JSON.stringify(variantSummary(variant));
        db.query("UPDATE publication_variants SET summary=?,summaryDigest=? WHERE id=?").run(
          summary,
          publicationSummaryDigest(summary, row.documentId, row.revisionId),
          row.id,
        );
      }
      db.exec("UPDATE publication_schema SET version=2 WHERE id=1");
    }
  }).immediate();
}
