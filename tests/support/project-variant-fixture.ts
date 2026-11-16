import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import type { Route } from "../../src/server/http/router.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { PublicationError } from "../../src/server/publishing/errors.js";
import { filePublicationSources } from "../../src/server/publishing/integration/file-document-source.js";
import { routePublicationSources } from "../../src/server/publishing/integration/source-routing.js";
import { createPublishingFeature } from "../../src/server/publishing/integration/feature.js";
import { PublicationVariantFiles } from "../../src/server/publishing/variant-files.js";
import { projectFileApiFixture } from "./project-file-api-fixture.js";

export async function projectVariantFixture() {
  const routes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-file-variants-")),
    projectId = "project-1",
    documentId = "doc-1",
    assetsRoot = join(root, "variants"),
    files = new PublicationVariantFiles(assetsRoot);
  let db = new Database(join(root, "tasks.sqlite"));
  const state = { legacyCalls: 0, ioInTransaction: false, contentReads: 0, afterPut: null as null | (() => void) };
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#7298ab" } })
    .png()
    .toBuffer();
  const initialized = await (async () => {
    const asset = await f
      .application()
      .assets.upload("writer", projectId, documentId, "Original cover.png", randomUUID(), bytes);
    const body: RichDocumentBody = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "LITERAL_SAVED_SOURCE. A clear paragraph.", marks: [{ type: "bold" }] }],
          },
          { type: "codeBlock", content: [{ type: "text", text: "const exact = 1;" }] },
          {
            type: "image",
            attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Original illustration" },
          },
        ],
      },
    };
    const draft = await f.application().editor.autosave("writer", projectId, documentId, {
      operationId: randomUUID(),
      version: 0,
      baseRevisionId: f.detail.revision.id,
      working: { title: "Saved original", locale: "en", body },
    });
    const saved = await f.application().editor.save("writer", projectId, documentId, {
      operationId: randomUUID(),
      revisionId: f.detail.revision.id,
      draftVersion: draft.version,
    });
    return { asset, body, saved };
  })().catch(async (error) => {
    db.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  const noLegacy = () => {
    state.legacyCalls++;
    throw new PublicationError("notFound", 404);
  };
  const bridge = routePublicationSources(
    {
      sources: { authorize: noLegacy, current: noLegacy, revision: noLegacy },
      assets: { content: async () => noLegacy() },
    },
    filePublicationSources({
      requireProject(id) {
        if (!f.grants.has(id)) throw new DocumentError("notFound", 404);
      },
      queries: {
        record(...args) {
          state.ioInTransaction ||= db.inTransaction;
          return f.application().queries.record(...args);
        },
        source(...args) {
          state.ioInTransaction ||= db.inTransaction;
          return f.application().queries.source(...args);
        },
      },
      assets: {
        metadata(...args) {
          state.ioInTransaction ||= db.inTransaction;
          return f.application().assets.metadata(...args);
        },
        content(...args) {
          state.ioInTransaction ||= db.inTransaction;
          return f.application().assets.content(...args);
        },
      },
    }),
  );
  const contents = {
    async put(content: Parameters<PublicationVariantFiles["put"]>[0]) {
      state.ioInTransaction ||= db.inTransaction;
      const digest = await files.put(content);
      state.afterPut?.();
      return digest;
    },
    async read(digest: string) {
      state.contentReads++;
      state.ioInTransaction ||= db.inTransaction;
      return files.read(digest);
    },
  };
  const open = () => createPublishingFeature(db, bridge.sources, bridge.assets, undefined, contents);
  let feature = open();
  routes.push(...feature.routes);
  return {
    f,
    root,
    assetsRoot,
    files,
    bytes,
    projectId,
    documentId,
    ...initialized,
    state,
    bridge,
    routes,
    feature: () => feature,
    db: () => db,
    prepare: (format: string = "html") =>
      f.call("/api/publication-variants", "POST", {
        projectId,
        documentId,
        revisionId: initialized.saved.detail.revision.id,
        mode: "format",
        format,
        templateId: "technical",
      }),
    restart() {
      db.close();
      db = new Database(join(root, "tasks.sqlite"));
      f.reopen();
      feature = open();
      routes.splice(0, routes.length, ...feature.routes);
    },
    async close() {
      db.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
