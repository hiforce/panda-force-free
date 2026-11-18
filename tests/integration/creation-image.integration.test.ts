import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { creationAppFixture } from "../support/creation-app.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import {
  ImageRenderJournal,
  imageRenderIntent,
} from "../../src/server/creation/integration/rendering/image-journal.js";
import { imageDigest } from "../../src/server/creation/integration/rendering/image-result.js";

// The model and provider are deterministic; HTTP, render journals, admission, Git originals and receipts are real.
test("image creation saves an owned original with selected planning guidance, recovers across restart and rejects document substitution", async () => {
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#26a2b7" } })
    .png()
    .toBuffer();
  let renders = 0,
    handle = "",
    journal!: ImageRenderJournal;
  const f = await creationAppFixture({
    assets: true,
    content(files, root) {
      journal = new ImageRenderJournal(join(root, "image-journal"));
      return {
        documents: creationFileDocuments(files.application()),
        image: {
          journal,
          available: async () => true,
          assets: async () => files.application().creations,
          renderer: {
            async render(input, callbacks) {
              await callbacks.authorize();
              callbacks.signal.throwIfAborted();
              const intent = await imageRenderIntent(input),
                saved = await journal.receipt(intent);
              if (saved) return saved;
              renders++;
              await journal.insert(intent, "intent", intent);
              return journal.save(intent, bytes, {
                digest: imageDigest(bytes),
                size: bytes.length,
                width: 64,
                height: 48,
                mime: "image/png",
                threadId: randomUUID(),
                turnId: randomUUID(),
              });
            },
          },
        },
      };
    },
  });
  try {
    const pack = (await f.files.call("/api/skill-packs/detail?id=panda-force.essentials&version=1.0.0")).body.package,
      request = {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        locale: "zh-CN",
        prompt: "请生成计算机发展历史的知识插画",
        profileId: "codex",
        outputType: "image",
        selections: [
          {
            packageId: pack.id,
            version: pack.version,
            digest: pack.digest,
            id: "science-illustration",
            parameters: {},
          },
        ],
      };
    f.onRun(async (input, callbacks, scope) => {
      const call = (name: string, args: unknown) =>
        callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
      expect(input.tools.some((t) => t.name === "panda_images_render")).toBe(true);
      expect((await f.save(callbacks, scope)).success).toBe(false);
      expect((await call("panda_images_render", { slot: 1, prompt: request.prompt })).success).toBe(false);
      const context = JSON.parse((await call("panda_creation_context", {})).text);
      expect(context.latestSkillGuidance[0].id).toBe("panda-force.essentials/science-illustration");
      expect((await f.save(callbacks, scope)).success).toBe(false);
      const rendered = await call("panda_images_render", { slot: 1, prompt: request.prompt });
      expect(rendered.success).toBe(true);
      expect(rendered.images?.[0]).toMatch(/^data:image\/webp;base64,/);
      handle = JSON.parse(rendered.text).handle;
      expect((await call("panda_images_render", { slot: 1, prompt: request.prompt })).success).toBe(true);
      const saved = await call("panda_artifacts_save", { kind: "image", handle, title: "计算机发展历程" });
      expect(saved.success).toBe(true);
      expect(JSON.parse(saved.text).kind).toBe("image");
      expect(await call("panda_artifacts_save", { kind: "image", handle, title: "Ignored replay" })).toEqual(saved);
    });
    expect((await f.files.call("/api/document-creations/options")).body.outputTypes).toEqual(["document", "image"]);
    expect((await f.files.call("/api/document-creations", "POST", request)).status).toBe(202);
    const task = await f.until(request.id, (t) => t.state === "succeeded" || !!t.failure);
    expect(task.state).toBe("succeeded");
    expect(task.artifact?.kind).toBe("image");
    if (task.artifact?.kind !== "image") throw Error("Expected real image receipt");
    expect("documentId" in task.artifact).toBe(false);
    expect(task.artifact.source.digest).toBe(imageDigest(bytes));
    expect(renders).toBe(1);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toEqual([]);
    expect((await f.files.application().creations.original("project-1", task.artifact.assetId)).bytes).toEqual(bytes);
    const download = await f.files.raw(
      "/api/creative-assets/content?" +
        new URLSearchParams({ project: "project-1", id: task.artifact.assetId, version: task.artifact.version }),
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array(bytes));
    const resolved = await journal.resolve("operator:test-user", request.id, handle);
    expect(resolved.receipt.bytes).toEqual(bytes);
    await expect(journal.resolve("other-owner", request.id, handle)).rejects.toThrow();
    await expect(journal.resolve("operator:test-user", randomUUID(), handle)).rejects.toThrow();
    await f.restart();
    expect((await f.task(request.id)).artifact).toEqual(task.artifact);
    expect((await f.files.call("/api/document-creations", "POST", request)).status).toBe(202);
    expect(renders).toBe(1);
    const firstAsset = task.artifact;
    f.onRun(async (_input, callbacks, scope) => {
      const call = (name: string, args: unknown) =>
        callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
      const context = JSON.parse((await call("panda_creation_context", {})).text);
      expect(context.previousAsset.artifact.assetId).toBe(firstAsset.assetId);
      const rendered = await call("panda_images_render", {
        slot: 1,
        prompt: "Retain the timeline and add a blue border",
        previousImage: true,
      });
      expect(rendered.success).toBe(true);
      expect(
        (
          await call("panda_artifacts_save", {
            kind: "image",
            handle: JSON.parse(rendered.text).handle,
            title: "Updated illustration",
          })
        ).success,
      ).toBe(true);
    });
    const nextId = randomUUID(),
      next = await f.files.call("/api/document-creations/follow-up", "POST", {
        taskId: request.id,
        id: nextId,
        prompt: "Add a blue border",
      });
    expect(next.status).toBe(202);
    const edited = await f.until(nextId, (t) => t.state === "succeeded" || !!t.failure);
    expect(edited.state).toBe("succeeded");
    expect(edited.artifact?.kind).toBe("image");
    if (edited.artifact?.kind !== "image") throw Error("Expected edited image");
    expect(edited.artifact.assetId).not.toBe(firstAsset.assetId);
    expect((await f.files.application().creations.original("project-1", firstAsset.assetId)).asset.version).toBe(
      firstAsset.version,
    );
    expect(renders).toBe(2);
    let documentRuns = 0;
    f.onRun(async (_input, callbacks, scope) => {
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      expect(_input.tools.some((tool) => tool.name === "panda_creation_original_read")).toBe(++documentRuns === 1);
      expect(_input.tools.some((tool) => tool.name === "panda_images_render")).toBe(false);
      if (documentRuns === 1) {
        const source = await callbacks.call({
          ...scope,
          callId: randomUUID(),
          name: "panda_creation_original_read",
          arguments: {},
        });
        expect(source.success).toBe(true);
        expect(source.images?.[0]).toMatch(/^data:image\/webp;base64,/);
      }
      expect((await f.save(callbacks, scope)).success).toBe(true);
    });
    const documentId = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/message", "POST", {
          taskId: nextId,
          id: documentId,
          prompt: "Now write an editable explanation of the illustration",
          outputType: "document",
        })
      ).status,
    ).toBe(202);
    const document = await f.until(documentId, (t) => t.state === "succeeded" || !!t.failure);
    expect(document.state).toBe("succeeded");
    if (document.artifact?.kind !== "document" || !document.artifact.file)
      throw Error("Expected a real document export");
    const savedMarkdown = await readFile(document.artifact.file.path);
    const revisionId = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/message", "POST", {
          taskId: documentId,
          id: revisionId,
          prompt: "Improve the explanation",
        })
      ).status,
    ).toBe(202);
    const revision = await f.until(revisionId, (t) => t.state === "succeeded" || !!t.failure);
    expect(revision.state).toBe("succeeded");
    if (revision.artifact?.kind !== "document") throw Error("Expected the same document");
    expect(revision.artifact.documentId).toBe(document.artifact.documentId);
    expect(revision.artifact.file?.path).toBe(document.artifact.file.path);
    expect((await readFile(document.artifact.file.path)).length).toBeGreaterThan(0);
    expect(savedMarkdown.length).toBeGreaterThan(0);
    expect((await f.files.application().creations.original("project-1", firstAsset.assetId)).asset.version).toBe(
      firstAsset.version,
    );
    f.actor("other-owner");
    expect((await f.files.call("/api/document-creations/detail?id=" + request.id)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 30000);

test("cancelling an image task fences a late provider callback before any primary asset is saved", async () => {
  let started!: () => void, finish!: () => void, observed!: () => void;
  const rendering = new Promise<void>((resolve) => {
      started = resolve;
    }),
    release = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    settled = new Promise<void>((resolve) => {
      observed = resolve;
    }),
    bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
      .png()
      .toBuffer(),
    f = await creationAppFixture({
      content(files, root) {
        return {
          documents: creationFileDocuments(files.application()),
          image: {
            journal: new ImageRenderJournal(join(root, "renders")),
            available: async () => true,
            assets: async () => files.application().creations,
            renderer: {
              async render() {
                started();
                await release;
                return { bytes, width: 8, height: 8, mime: "image/png" };
              },
            },
          },
        };
      },
    });
  try {
    f.onRun(async (_input, callbacks, scope) => {
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      try {
        await callbacks.call({
          ...scope,
          callId: randomUUID(),
          name: "panda_images_render",
          arguments: { slot: 1, prompt: "A finished image" },
        });
      } catch {
        observed();
      }
    });
    const request = {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      locale: "en",
      prompt: "Generate an image",
      profileId: "codex",
      outputType: "image",
      selections: [],
    };
    expect((await f.files.call("/api/document-creations", "POST", request)).status).toBe(202);
    await rendering;
    expect((await f.files.call("/api/document-creations/cancel", "POST", { id: request.id })).status).toBe(200);
    finish();
    await settled;
    expect((await f.task(request.id)).state).toBe("cancelled");
    expect((await f.task(request.id)).artifact).toBeNull();
    expect((await f.files.application().creations.list("project-1")).assets).toEqual([]);
  } finally {
    finish();
    await f.close();
  }
}, 30000);
