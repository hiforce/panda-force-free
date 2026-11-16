import { Database } from "bun:sqlite";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import type { Route } from "../../src/server/http/router.js";
import type { EditorialModel } from "../../src/server/editorial/model/contracts.js";
import { EditorialError } from "../../src/server/editorial/errors.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { createEditorialFeature } from "../../src/server/editorial/integration/feature.js";
import { routeEditorialSources } from "../../src/server/editorial/integration/source-routing.js";
import { fileDocumentEditorialSources } from "../../src/server/editorial/integration/file-document-source.js";
import { projectFileApiFixture } from "./project-file-api-fixture.js";

export const fileReviewBody = (text = "This are  a test.  "): RichDocumentBody => ({
  schema: 1,
  format: "richtext",
  document: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text, marks: [{ type: "bold" }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "const  protected = 1;" }] },
    ],
  },
});
export async function projectEditorialFixture(options: { image?: boolean } = {}) {
  const extraRoutes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes }),
    root = await mkdtemp(join(tmpdir(), "panda-file-editorial-")),
    projectId = "project-1",
    documentId = "doc-1",
    originalBody = fileReviewBody();
  const initialized = await (async () => {
    const asset = options.image
      ? await f.application().assets.upload(
          "writer",
          projectId,
          documentId,
          "owned.png",
          randomUUID(),
          await sharp({ create: { width: 2, height: 2, channels: 3, background: "#476a8e" } })
            .png()
            .toBuffer(),
        )
      : null;
    if (asset)
      originalBody.document.content!.push({
        type: "image",
        attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Owned test image" },
      });
    const draft = await f.application().editor.autosave("writer", projectId, documentId, {
        operationId: randomUUID(),
        version: 0,
        baseRevisionId: f.detail.revision.id,
        working: { title: f.detail.revision.title, locale: "en", body: originalBody },
      }),
      checkpoint = await f.application().editor.save("writer", projectId, documentId, {
        operationId: randomUUID(),
        revisionId: f.detail.revision.id,
        draftVersion: draft.version,
      });
    return { asset, checkpoint };
  })().catch(async (error) => {
    await f.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  const { asset, checkpoint } = initialized;
  const state = { legacyCalls: 0, ioInTransaction: false, modelCalls: 0 };
  let db = new Database(join(root, "review.sqlite")),
    feature: ReturnType<typeof createEditorialFeature>;
  const model: EditorialModel = {
    profile: { id: "review", model: "fixture", engine: "isolated-test", version: "1" },
    async process(input) {
      state.modelCalls++;
      return JSON.stringify({
        edits: input.segments.map((segment) => ({
          segmentId: segment.id,
          before: segment.text,
          after: segment.text.replace("are", "is"),
          reason: "Agreement",
        })),
      });
    },
  };
  const noLegacy = () => {
    state.legacyCalls++;
    throw new EditorialError("notFound", 404);
  };
  function open() {
    feature = createEditorialFeature(
      db,
      routeEditorialSources(
        { authorize: noLegacy, current: noLegacy, revision: noLegacy, apply: noLegacy, applied: noLegacy },
        fileDocumentEditorialSources({
          requireProject(id) {
            if (!f.grants.has(id)) throw new DocumentError("notFound", 404);
          },
          queries: {
            record(...args) {
              state.ioInTransaction ||= db.inTransaction;
              return f.application().queries.record(...args);
            },
            revision(...args) {
              state.ioInTransaction ||= db.inTransaction;
              return f.application().queries.revision(...args);
            },
          },
          changes: {
            apply(...args) {
              state.ioInTransaction ||= db.inTransaction;
              return f.application().changes.apply(...args);
            },
            receipt(...args) {
              state.ioInTransaction ||= db.inTransaction;
              return f.application().changes.receipt(...args);
            },
          },
        }),
      ),
      { models: new Map([[model.profile.id, model]]) },
    );
    extraRoutes.splice(0, extraRoutes.length, ...feature.routes);
  }
  try {
    open();
  } catch (error) {
    db.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const prepare = (id = randomUUID()) =>
    f.call("/api/document-editorial", "POST", {
      id,
      projectId,
      documentId,
      revisionId: checkpoint.detail.revision.id,
      mode: "spacing",
    });
  return {
    f,
    root,
    projectId,
    documentId,
    checkpoint,
    asset,
    state,
    model,
    prepare,
    db: () => db,
    feature: () => feature,
    async restart() {
      await feature.stop();
      db.close();
      db = new Database(join(root, "review.sqlite"));
      f.reopen();
      open();
    },
    async close() {
      await feature.stop();
      db.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
