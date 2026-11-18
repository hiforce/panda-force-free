import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { creationAppFixture } from "../support/creation-app.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { ImageRenderJournal } from "../../src/server/creation/integration/rendering/image-journal.js";
import { CreationGeneratedOriginals } from "../../src/server/creation/integration/rendering/generated-originals.js";
import { nativeCreationGenerators } from "../../src/server/creation/integration/rendering/generators.js";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import type { CreationArtifact } from "../../src/shared/creation/contracts.js";

test("real HTTP slide and web tools save actual owned files, preserve type and original bytes across restart", async () => {
  const f = await creationAppFixture({
    assets: true,
    content(files, root) {
      return {
        documents: creationFileDocuments(files.application()),
        image: {
          journal: new ImageRenderJournal(join(root, "images")),
          renderer: {
            async render() {
              throw Error("No image inference requested");
            },
          },
          available: async () => false,
          assets: async () => files.application().creations,
          generated: new CreationGeneratedOriginals(join(root, "generated")),
          generators: nativeCreationGenerators(),
        },
      };
    },
  });
  try {
    const options = await f.files.call("/api/document-creations/options");
    expect(options.body.outputTypes).toEqual(["document", "slides", "web"]);
    const originals: { id: string; artifact: CreationArtifact }[] = [];
    for (const kind of ["slides", "web"] as const) {
      const id = randomUUID();
      f.onRun(async (input, callbacks, scope) => {
        const call = (name: string, args: unknown) =>
          callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
        expect(
          input.tools.some((d) => d.name === (kind === "slides" ? "panda_slides_render" : "panda_web_render")),
        ).toBe(true);
        await call("panda_creation_context", {});
        const value =
          kind === "slides"
            ? {
                slot: 1,
                pages: [
                  { layout: "cover", title: "计算机发展史", body: "从机械计算到人工智能" },
                  { layout: "content", title: "电子计算机", body: "1946年：ENIAC亮相\n电子管推动通用计算" },
                ],
              }
            : {
                slot: 1,
                html: "<!doctype html><html lang='zh-CN'><title>计算机发展史</title><style>body{font:18px system-ui}button{padding:1rem}</style><h1>计算机发展史</h1><p>从机械计算到人工智能</p><button id='next'>下一阶段</button><script>document.querySelector('button').onclick=()=>document.querySelector('p').textContent='电子计算机';</script></html>",
              };
        const rendered = await call(kind === "slides" ? "panda_slides_render" : "panda_web_render", value);
        expect(rendered.success).toBe(true);
        const handle = JSON.parse(rendered.text).handle;
        const repeated = await call(kind === "slides" ? "panda_slides_render" : "panda_web_render", value);
        expect(JSON.parse(repeated.text).handle).toBe(handle);
        expect((await call("panda_artifacts_save", { kind, handle, title: "计算机发展史" })).success).toBe(true);
      });
      expect(
        (
          await f.files.call("/api/document-creations", "POST", {
            id,
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            locale: "zh-CN",
            prompt: "生成真实成品",
            profileId: "codex",
            outputType: kind,
            selections: [],
          })
        ).status,
      ).toBe(202);
      const task = await f.until(id, (t) => t.state === "succeeded" || !!t.failure);
      expect(task.state).toBe("succeeded");
      if (!task.artifact || task.artifact.kind === "document") throw Error("Expected actual original");
      expect(task.artifact.kind).toBe(kind);
      const original = await f.files.application().creations.original("project-1", task.artifact.assetId);
      if (kind === "slides") {
        const deck = await NativePresentation.open(original.bytes, "Actual.pptx");
        expect(deck.index.slides).toHaveLength(2);
        expect(deck.part(deck.index.slides[0]!.path).shapes.find((s) => s.id === "2")?.text).toBe("计算机发展史");
      } else expect(original.bytes.toString()).toContain("<script>");
      const response = await f.files.raw(
        "/api/creative-assets/content?" +
          new URLSearchParams({ project: "project-1", id: task.artifact.assetId, version: task.artifact.version }),
      );
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(original.bytes));
      originals.push({ id, artifact: task.artifact });
      const first = task.artifact,
        oldBytes = Buffer.from(original.bytes),
        nextId = randomUUID();
      let callbackError: unknown;
      f.onRun(async (_input, callbacks, scope) => {
        try {
          const call = (name: string, args: unknown) =>
            callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
          await call("panda_creation_context", {});
          if (kind === "slides")
            expect(
              (
                await call("panda_slides_edit", {
                  slot: 8,
                  sourceId: "a".repeat(64),
                  changes: [{ slot: "s-guessed", text: "Wrong" }],
                })
              ).success,
            ).toBe(false);
          const read = await call("panda_creation_original_read", {});
          expect(read.success).toBe(true);
          const source = JSON.parse(read.text);
          expect(source.kind).toBe(kind);
          expect(source.nextOffset).toBe(null);
          const edit =
            kind === "slides"
              ? {
                  slot: 1,
                  sourceId: source.sourceId,
                  changes: [
                    {
                      slot: JSON.parse(source.text).shapes.find((s: { text: string }) => s.text === "计算机发展史")
                        .slot,
                      text: "计算机发展史：修订版",
                    },
                  ],
                }
              : {
                  slot: 1,
                  sourceId: source.sourceId,
                  retainedResources: [],
                  html: source.text.replace(/计算机发展史/g, "计算机发展史：修订版"),
                };
          const rendered = await call(kind === "slides" ? "panda_slides_edit" : "panda_web_render", edit);
          expect(rendered.success).toBe(true);
          expect(
            (
              await call("panda_artifacts_save", {
                kind,
                handle: JSON.parse(rendered.text).handle,
                title: "计算机发展史：修订版",
              })
            ).success,
          ).toBe(true);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      });
      expect(
        (
          await f.files.call("/api/document-creations/follow-up", "POST", {
            taskId: id,
            id: nextId,
            prompt: "仅把标题更新为修订版，保留其他内容",
          })
        ).status,
      ).toBe(202);
      const edited = await f.until(nextId, (t) => t.state === "succeeded" || !!t.failure);
      if (callbackError) throw callbackError;
      expect(edited.state).toBe("succeeded");
      if (!edited.artifact || edited.artifact.kind === "document") throw Error("Expected edited original");
      expect(edited.artifact.kind).toBe(kind);
      expect(edited.artifact.assetId).not.toBe(first.assetId);
      const revised = await f.files.application().creations.original("project-1", edited.artifact.assetId);
      if (kind === "slides") {
        const deck = await NativePresentation.open(revised.bytes, "Revised.pptx"),
          prior = await NativePresentation.open(oldBytes, "Original.pptx");
        expect(deck.index.slides).toHaveLength(2);
        expect(deck.part(deck.index.slides[0]!.path).shapes.find((s) => s.id === "2")?.text).toBe(
          "计算机发展史：修订版",
        );
        expect(deck.parts.tree.read(deck.index.slides[1]!.path)).toEqual(
          prior.parts.tree.read(prior.index.slides[1]!.path),
        );
      } else {
        expect(revised.bytes.toString()).toContain("计算机发展史：修订版");
        expect(revised.bytes.toString()).toContain("<script>");
      }
      expect((await f.files.application().creations.original("project-1", first.assetId)).bytes).toEqual(oldBytes);
      originals.push({ id: nextId, artifact: edited.artifact });
    }
    expect((await f.files.application().navigation.tree("project-1")).nodes).toEqual([]);
    await f.restart();
    for (const original of originals) expect((await f.task(original.id)).artifact).toEqual(original.artifact);
  } finally {
    await f.close();
  }
}, 30000);
