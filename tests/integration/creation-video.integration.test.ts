import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { creationAppFixture } from "../support/creation-app.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { ImageRenderJournal } from "../../src/server/creation/integration/rendering/image-journal.js";
import { CreationGeneratedOriginals } from "../../src/server/creation/integration/rendering/generated-originals.js";
import { nativeCreationGenerators } from "../../src/server/creation/integration/rendering/generators.js";
import {
  NativeCreationVideoRenderer,
  VIDEO_COMPOSITION_RESOURCE,
} from "../../src/server/creation/integration/rendering/native-video.js";

test("actual video synthesis saves playable H.264, completes its goal only after saving and rebuilds an owned composition without changing the previous original", async () => {
  let videoRoot = "";
  const f = await creationAppFixture({
    assets: true,
    content(files, root) {
      videoRoot = join(root, "video");
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
          generators: nativeCreationGenerators(new NativeCreationVideoRenderer(videoRoot)),
        },
      };
    },
  });
  try {
    const id = randomUUID();
    let callbackError: unknown;
    f.onRun(async (_input, callbacks, scope) => {
      try {
        const call = (name: string, args: unknown) =>
          callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
        expect(
          (
            await call("panda_creation_goal", {
              action: "create",
              objective: "Create an actual silent computer-history motion graphic",
            })
          ).success,
        ).toBe(true);
        await call("panda_creation_context", {});
        const result = await call("panda_videos_render", {
          slot: 1,
          aspect: "portrait",
          scenes: [
            { duration: 3, heading: "计算机发展史", text: "从机械计算到电子计算机。" },
            { duration: 3, heading: "电子计算时代", text: "电子管、晶体管与集成电路让计算机不断变小。" },
          ],
        });
        expect(result.success).toBe(true);
        expect(JSON.parse(result.text).renderingMode).toBe("motion-graphics-silent");
        const running = await f.task(id);
        expect(running.artifact).toBe(null);
        expect(running.goal?.status).toBe("active");
        expect(
          (
            await call("panda_artifacts_save", {
              kind: "video",
              handle: JSON.parse(result.text).handle,
              title: "计算机发展史",
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
        await f.files.call("/api/document-creations", "POST", {
          id,
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          locale: "zh-CN",
          prompt: "请使用一个goal生成真实无配音动态图文视频",
          profileId: "codex",
          outputType: "video",
          selections: [],
        })
      ).status,
    ).toBe(202);
    const task = await f.until(id, (t) => t.state === "succeeded" || !!t.failure);
    if (callbackError) throw callbackError;
    expect(task.state).toBe("succeeded");
    expect(task.goal?.status).toBe("completed");
    if (task.artifact?.kind !== "video") throw Error("Expected saved video");
    const original = await f.files.application().creations.original("project-1", task.artifact.assetId);
    expect(original.bytes.length).toBeGreaterThan(10000);
    expect(original.resources.some((r) => r.name === VIDEO_COMPOSITION_RESOURCE)).toBe(true);
    const view =
      "/api/creative-assets/view?" +
      new URLSearchParams({ project: "project-1", id: task.artifact.assetId, version: task.artifact.version });
    const range = await f.files.raw(view, "GET", undefined, { Range: "bytes=0-255" });
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array(original.bytes.subarray(0, 256)));
    const nextId = randomUUID();
    f.onRun(async (_input, callbacks, scope) => {
      try {
        const call = (name: string, args: unknown) =>
          callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
        await call("panda_creation_context", {});
        const read = JSON.parse((await call("panda_creation_original_read", {})).text),
          composition = JSON.parse(read.text);
        expect(composition.mode).toBe("motion-graphics-silent");
        composition.scenes[0].heading = "计算机发展史：修订版";
        const result = await call("panda_videos_render", {
          slot: 1,
          sourceId: read.sourceId,
          aspect: composition.aspect,
          scenes: composition.scenes,
        });
        expect(result.success).toBe(true);
        expect(
          (
            await call("panda_artifacts_save", {
              kind: "video",
              handle: JSON.parse(result.text).handle,
              title: "修订视频",
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
          prompt: "仅修改第一个场景标题",
        })
      ).status,
    ).toBe(202);
    const edited = await f.until(nextId, (t) => t.state === "succeeded" || !!t.failure);
    if (callbackError) throw callbackError;
    expect(edited.state).toBe("succeeded");
    if (edited.artifact?.kind !== "video") throw Error("Expected revised video");
    expect(edited.artifact.assetId).not.toBe(task.artifact.assetId);
    expect((await f.files.application().creations.original("project-1", task.artifact.assetId)).bytes).toEqual(
      original.bytes,
    );
    expect(await readdir(videoRoot)).toEqual([]);
    await f.restart();
    expect((await f.task(nextId)).artifact).toEqual(edited.artifact);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toEqual([]);
  } finally {
    await f.close();
  }
}, 60000);

test("independent renderer capability probes start in parallel and an unavailable provider cannot hide other formats", async () => {
  const image = Promise.withResolvers<boolean>(),
    video = Promise.withResolvers<boolean>(),
    entered = Promise.withResolvers<void>();
  const f = await creationAppFixture({
    assets: true,
    content(files, root) {
      return {
        documents: creationFileDocuments(files.application()),
        image: {
          journal: new ImageRenderJournal(join(root, "images")),
          renderer: {
            async render() {
              throw Error("No inference requested");
            },
          },
          available: () => image.promise,
          assets: async () => files.application().creations,
          generated: new CreationGeneratedOriginals(join(root, "generated")),
          generators: [
            ...nativeCreationGenerators(),
            {
              kind: "video",
              definition: {
                name: "panda_videos_render",
                description: "Fixture readiness probe",
                inputSchema: { type: "object", properties: {} },
              },
              available: async () => {
                entered.resolve();
                return video.promise;
              },
              render: async () => {
                throw Error("No rendering requested");
              },
            },
          ],
        },
      };
    },
  });
  try {
    const request = f.files.call("/api/document-creations/options");
    await Promise.race([
      entered.promise,
      Bun.sleep(1000).then(() => {
        throw Error("Video probe was blocked behind image readiness");
      }),
    ]);
    image.resolve(false);
    video.resolve(true);
    expect((await request).body.outputTypes).toEqual(["document", "slides", "web", "video"]);
  } finally {
    image.resolve(false);
    video.resolve(false);
    await f.close();
  }
}, 10000);
