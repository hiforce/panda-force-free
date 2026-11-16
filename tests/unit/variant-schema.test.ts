import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseContent } from "../../src/server/publishing/content/parse.js";
import { transformContent } from "../../src/server/publishing/variant-transform.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { builtinChannelTemplates } from "../../src/shared/presentation/templates.js";
import { VariantRepository } from "../../src/server/publishing/variant-repository.js";

function legacy() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE publication_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
    INSERT INTO publication_schema VALUES(1,1);
    CREATE TABLE publication_variants(id TEXT PRIMARY KEY,documentId TEXT NOT NULL,revisionId TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,review TEXT,createdAt INTEGER NOT NULL,sourceSnapshot TEXT NOT NULL);
    CREATE TABLE publication_reviews(id INTEGER PRIMARY KEY,variantId TEXT NOT NULL,payload TEXT NOT NULL,reviewedAt INTEGER NOT NULL);`);
  const ir = parseContent({
    documentId: "doc",
    revisionId: "rev",
    title: "Original",
    locale: "en",
    content: "Keep the original source.",
    engine: "markdown",
  });
  const variant = transformContent(
      ir,
      "html",
      builtinChannelTemplates.resolve("technical"),
      builtinFormats().get("html")!,
    ),
    payload = JSON.stringify(variant),
    sourceSnapshot = JSON.stringify(ir),
    digest = createHash("sha256")
      .update(payload + "\n" + sourceSnapshot)
      .digest("hex"),
    review = JSON.stringify({ digest, reviewer: "operator", reviewedAt: 100, acceptedIssues: [] });
  db.query("INSERT INTO publication_variants VALUES(?,?,?,?,?,?,?,?)").run(
    variant.id,
    "doc",
    "rev",
    payload,
    digest,
    review,
    variant.createdAt,
    sourceSnapshot,
  );
  return { db, variant, payload, sourceSnapshot, digest, review };
}
test("variant schema migration preserves every legacy payload, review and digest while deriving bounded history metadata", () => {
  const f = legacy();
  try {
    const repo = new VariantRepository(f.db);
    expect(
      f.db
        .query("SELECT payload,sourceSnapshot,digest,review,sourceProjectId,referenceDigest FROM publication_variants")
        .get(),
    ).toEqual({
      payload: f.payload,
      sourceSnapshot: f.sourceSnapshot,
      digest: f.digest,
      review: f.review,
      sourceProjectId: null,
      referenceDigest: null,
    });
    expect(repo.get(f.variant.id).digest).toBe(f.digest);
    expect(repo.list("doc")).toHaveLength(1);
    expect(repo.list("doc", "some-project")).toEqual([]);
    expect(repo.files.reference(f.variant.id)).toBeNull();
    f.db.query("UPDATE publication_variants SET payload='corrupt body'").run();
    expect(repo.list("doc")[0]!.title).toBe("Original");
    expect(() => repo.get(f.variant.id)).toThrow("unavailable");
    f.db.query("UPDATE publication_variants SET summary='{}'").run();
    expect(() => repo.list("doc")).toThrow("unavailable");
  } finally {
    f.db.close();
  }
});
test("a corrupt old variant rolls back the whole schema upgrade without silently replacing its source or digest", () => {
  const f = legacy();
  try {
    f.db.query("UPDATE publication_variants SET payload='corrupt body'").run();
    const before = f.db.query("PRAGMA table_info(publication_variants)").all();
    expect(() => new VariantRepository(f.db)).toThrow("unavailable");
    expect(f.db.query("SELECT version FROM publication_schema").get()).toEqual({ version: 1 });
    expect(f.db.query("PRAGMA table_info(publication_variants)").all()).toEqual(before);
    expect(f.db.query("SELECT payload,digest,sourceSnapshot FROM publication_variants").get()).toEqual({
      payload: "corrupt body",
      digest: f.digest,
      sourceSnapshot: f.sourceSnapshot,
    });
  } finally {
    f.db.close();
  }
});
