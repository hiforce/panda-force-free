import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { VariantRepository } from "../../src/server/publishing/variant-repository.js";
import { VariantService, issueKey } from "../../src/server/publishing/variant-service.js";
import { VariantExporter } from "../../src/server/publishing/export-service.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import type { ContentSource } from "../../src/server/publishing/content/parse.js";

function fixture(content = "An ordinary paragraph.") {
  const db = new Database(":memory:");
  const source: ContentSource = {
    documentId: "doc",
    revisionId: "rev",
    title: "Article",
    locale: "en",
    engine: "markdown",
    content,
  };
  let current = source.revisionId;
  const sources = {
    authorize: () => () => {},
    current: (id: string) => {
      if (id !== "doc") throw Error("Forbidden source");
      return { revisionId: current };
    },
    revision: (id: string, revision: string) => {
      if (id !== "doc" || revision !== "rev") throw Error("Forbidden revision");
      return source;
    },
  };
  const service = new VariantService(new VariantRepository(db), sources, builtinFormats());
  const prepare = (format = "html") =>
    service.prepare({ documentId: "doc", revisionId: "rev", mode: "format", format, templateId: "technical" });
  return {
    db,
    service,
    prepare,
    advance: () => {
      current = "next-revision";
    },
  };
}
test("variants freeze revision content, require review of losses, and become stale without mutating old receipts", async () => {
  const f = fixture("<custom-element>Preserve me</custom-element>");
  try {
    const prepared = await f.prepare();
    expect(prepared.review).toBeNull();
    await expect(
      f.service.review(prepared.variant.id, { digest: prepared.digest, acceptedIssues: [] }, "reviewer"),
    ).rejects.toThrow("reviewRequired");
    const acceptedIssues = prepared.variant.issues.map(issueKey);
    const reviewed = await f.service.review(
      prepared.variant.id,
      { digest: prepared.digest, acceptedIssues },
      "reviewer",
    );
    expect(reviewed.review?.reviewer).toBe("reviewer");
    f.advance();
    const old = await f.service.detail(prepared.variant.id);
    expect(old.stale).toBe(true);
    expect(old.variant.source.revisionId).toBe("rev");
    expect(old.variant.html).toContain("Preserve me");
    expect(old.review?.digest).toBe(reviewed.digest);
    await expect(
      f.service.review(prepared.variant.id, { digest: prepared.digest, acceptedIssues }, "reviewer"),
    ).rejects.toThrow("staleSource");
    await expect(f.prepare()).rejects.toThrow("staleSource");
  } finally {
    f.db.close();
  }
});
test("formatting cannot silently become a rewrite, and oversized X posts cannot be reviewed", async () => {
  const f = fixture("word ".repeat(100));
  try {
    await expect(
      f.service.prepare({
        documentId: "doc",
        revisionId: "rev",
        mode: "rewrite",
        format: "html",
        templateId: "technical",
      }),
    ).rejects.toThrow("unsupportedMode");
    const post = await f.prepare("x-post");
    expect(post.variant.posts[0]?.valid).toBe(false);
    await expect(
      f.service.review(post.variant.id, { digest: post.digest, acceptedIssues: [] }, "reviewer"),
    ).rejects.toThrow("blockedContent");
    const thread = await f.prepare("x-thread");
    expect(thread.variant.posts.length).toBeGreaterThan(1);
  } finally {
    f.db.close();
  }
});
test("proofreading produces a reviewable proposal without changing the document or making a variant", async () => {
  const f = fixture("Two  spaces.\n\n> Quote  protected.");
  try {
    const proposals = await f.service.proofreading("doc", "rev");
    const applied = await f.service.proofreadProposal(
      "doc",
      "rev",
      proposals.map((p) => p.id),
    );
    expect(applied.content).toContain("Two spaces.");
    expect(applied.content).toContain("Quote  protected.");
    expect(await f.service.list("doc")).toHaveLength(0);
    expect(await f.service.proofreading("doc", "rev")).toEqual(proposals);
  } finally {
    f.db.close();
  }
});
test("exports include only referenced authorized images, original filenames, immutable source and a loss manifest", async () => {
  const assetId = "11111111-1111-1111-1111-111111111111";
  const source = `/api/document-assets/content?id=${assetId}`;
  const f = fixture(`![Picture](${source})\n\n![Remote](https://example.com/private.jpg)\n\nText.`);
  try {
    const variant = await f.prepare();
    const reads: string[] = [];
    const exporter = new VariantExporter(
      f.service,
      {
        async content(document, id) {
          reads.push(id);
          expect(document).toBe("doc");
          if (id !== assetId) throw Error("Unexpected asset");
          return { name: "original image.png", mime: "image/png", digest: "digest", bytes: new Uint8Array([1, 2, 3]) };
        },
      },
      builtinFormats(),
    );
    const exported = await exporter.export(variant.variant.id, "bundle");
    const files = unzipSync(exported.bytes);
    const path = `assets/${assetId}/original image.png`;
    expect(files[path]).toEqual(new Uint8Array([1, 2, 3]));
    expect(strFromU8(files["article.html"]!)).toContain("original%20image.png");
    expect(strFromU8(files["article.html"]!)).not.toContain('src="https://');
    expect(strFromU8(files["source.md"]!)).toContain(source);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest.assets.map((a: { state: string }) => a.state)).toEqual(["included", "external"]);
    expect(reads).toEqual([assetId]);
    const inline = await exporter.export(variant.variant.id, "html");
    expect(strFromU8(inline.bytes)).toContain("data:image/png;base64,AQID");
  } finally {
    f.db.close();
  }
});
