import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { projectVariantFixture } from "../support/project-variant-fixture.js";

test.concurrent(
  "file variants freeze saved text and owned image references outside SQL and project Git across restart",
  async () => {
    const t = await projectVariantFixture();
    try {
      const head = await t.f.snapshots.head(),
        original = await t.f.application().queries.detail(t.projectId, t.documentId);
      for (const format of ["html", "x-post", "x-thread", "x-article"]) {
        const response = await t.prepare(format);
        expect(response.status).toBe(201);
        expect(response.body.variant.source).toEqual({
          documentId: t.documentId,
          revisionId: original.revision.id,
          sourceHash: original.revision.contentHash,
          projectId: t.projectId,
          commit: head,
        });
        expect(response.body.variant.format).toBe(format);
      }
      const list = await t.f.call("/api/publication-variants?document=doc-1&project=project-1");
      expect(list.body.variants).toHaveLength(4);
      const html = list.body.variants.find((item: { format: string }) => item.format === "html");
      const detail = (await t.f.call("/api/publication-variants/detail?id=" + html.id)).body;
      const reviewed = await t.f.call("/api/publication-variants/review", "POST", {
        id: html.id,
        digest: detail.digest,
        acceptedIssues: detail.variant.issues.map(
          (issue: { blockId: string; code: string }) => issue.blockId + ":" + issue.code,
        ),
      });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.review.digest).toBe(detail.digest);
      const editor = await t.f.application().queries.editor(t.projectId, t.documentId);
      await t.f.application().editor.autosave("writer", t.projectId, t.documentId, {
        operationId: randomUUID(),
        version: editor.draft.version,
        baseRevisionId: editor.draft.baseRevisionId,
        working: { ...editor.working, title: "An unsaved later draft" },
      });
      t.restart();
      const exportResult = await t.feature().exporter.export(html.id, "bundle"),
        bundle = unzipSync(exportResult.bytes);
      expect(JSON.parse(strFromU8(bundle["source.rich.json"]!))).toEqual(original.revision.body);
      expect(bundle["assets/" + t.asset.id + "/Original cover.png"]).toEqual(new Uint8Array(t.bytes));
      const manifest = JSON.parse(strFromU8(bundle["manifest.json"]!));
      expect(manifest.source.commit).toBe(head);
      expect(manifest.stale).toBe(false);
      expect(manifest.review.digest).toBe(detail.digest);
      expect((await t.f.application().queries.editor(t.projectId, t.documentId)).working.title).toBe(
        "An unsaved later draft",
      );
      expect(await t.f.snapshots.head()).toBe(head);
      const rows = t
        .db()
        .query<{ payload: string; sourceSnapshot: string }, []>(
          "SELECT payload,sourceSnapshot FROM publication_variants",
        )
        .all();
      expect(rows).toHaveLength(4);
      expect(JSON.stringify(rows)).not.toContain("LITERAL_SAVED_SOURCE");
      const artifacts = await readdir(t.assetsRoot);
      expect(artifacts).toHaveLength(4);
      expect(await readFile(join(t.assetsRoot, detail.digest + ".json"), "utf8")).toContain("LITERAL_SAVED_SOURCE");
      expect(
        (await t.f.snapshots.entries(head)).some((row) => row.path.includes("variant") || row.path.endsWith(".png")),
      ).toBe(false);
      expect(t.state.ioInTransaction).toBe(false);
      expect(t.state.legacyCalls).toBe(0);
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "file variant history is scoped metadata and missing or corrupt artifacts never fall back to SQL or another source",
  async () => {
    const t = await projectVariantFixture();
    try {
      const prepared = (await t.prepare()).body,
        id = prepared.variant.id;
      const list = "/api/publication-variants?document=doc-1&project=project-1";
      expect((await t.f.call("/api/publication-variants?document=doc-1&project=foreign")).status).toBe(404);
      const reads = t.state.contentReads;
      expect((await t.f.call(list)).body.variants).toHaveLength(1);
      expect(t.state.contentReads).toBe(reads);
      t.f.grants.clear();
      expect((await t.f.call("/api/publication-variants/detail?id=" + id)).status).toBe(404);
      expect(t.state.contentReads).toBe(reads);
      t.f.grants.add(t.projectId);
      const path = join(t.assetsRoot, prepared.digest + ".json"),
        bytes = await readFile(path);
      await writeFile(path, "corrupt generated artifact");
      expect((await t.f.call("/api/publication-variants/detail?id=" + id)).status).toBe(503);
      expect((await t.f.call(list)).body.variants).toHaveLength(1);
      await unlink(path);
      expect((await t.f.call("/api/publication-variants/detail?id=" + id)).status).toBe(503);
      await writeFile(path, bytes);
      expect((await t.f.call("/api/publication-variants/detail?id=" + id)).status).toBe(200);
      t.db().query("UPDATE publication_variants SET payload='{}' WHERE id=?").run(id);
      expect((await t.f.call("/api/publication-variants/detail?id=" + id)).status).toBe(503);
      expect(t.state.legacyCalls).toBe(0);
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "file variant creation rechecks project policy after artifact persistence and keeps database IO synchronous",
  async () => {
    const t = await projectVariantFixture();
    try {
      const head = await t.f.snapshots.head();
      t.state.afterPut = () => t.f.grants.clear();
      expect((await t.prepare()).status).toBe(404);
      expect(t.db().query("SELECT COUNT(*) AS count FROM publication_variants").get()).toEqual({ count: 0 });
      expect(await t.f.snapshots.head()).toBe(head);
      expect(t.state.ioInTransaction).toBe(false);
      expect(t.state.legacyCalls).toBe(0);
    } finally {
      await t.close();
    }
  },
  30000,
);
